"""DuckDB-backed engine: loads files as tables, runs SQL, pages results, exports."""

import csv
import datetime
import decimal
import os
import re
import tempfile
import threading
import time
import uuid

import duckdb

RESULT_SCHEMA = "_results"
EXCEL_EXTS = {".xlsx", ".xlsm", ".xls", ".xlsb", ".ods"}
CSV_EXTS = {".csv", ".tsv", ".txt", ".tab", ".dat"}
PARQUET_EXTS = {".parquet", ".pq"}
JSON_EXTS = {".json", ".jsonl", ".ndjson"}
EXCEL_MAX_ROWS = 1_048_576
MAX_SAFE_INT = 2**53

# Statements that return rows but cannot be used directly after CREATE TABLE ... AS.
_WRAP_ONLY = re.compile(r"^\s*(describe|summarize|show|pragma|explain)\b", re.I)
_ERR_LINE = re.compile(r"LINE (\d+): (.*)\n(\s*)\^")


class QueryError(Exception):
    pass


# ---------------------------------------------------------------- helpers

def quote_ident(name):
    return '"' + str(name).replace('"', '""') + '"'


def quote_str(value):
    return "'" + str(value).replace("'", "''") + "'"


def sanitize_name(raw):
    name = re.sub(r"[^0-9a-zA-Z_]+", "_", str(raw)).strip("_").lower()
    if not name:
        name = "table"
    if name[0].isdigit():
        name = "t_" + name
    return name


def file_kind(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in EXCEL_EXTS:
        return "excel"
    if ext in PARQUET_EXTS:
        return "parquet"
    if ext in JSON_EXTS:
        return "json"
    return "csv"


def split_statements(sql):
    """Split SQL on top-level semicolons. Returns [(text, start_offset)], skipping empty pieces."""
    pieces, start, i, n = [], 0, 0, len(sql)
    while i < n:
        ch = sql[i]
        if ch == "-" and sql.startswith("--", i):
            j = sql.find("\n", i)
            i = n if j < 0 else j + 1
            continue
        if ch == "/" and sql.startswith("/*", i):
            j = sql.find("*/", i + 2)
            i = n if j < 0 else j + 2
            continue
        if ch in ("'", '"'):
            j = i + 1
            while j < n:
                if sql[j] == ch:
                    if j + 1 < n and sql[j + 1] == ch:
                        j += 2
                        continue
                    break
                j += 1
            i = j + 1
            continue
        if ch == "$":
            m = re.match(r"\$[A-Za-z_]*\$", sql[i:])
            if m:
                tag = m.group(0)
                j = sql.find(tag, i + len(tag))
                i = n if j < 0 else j + len(tag)
                continue
        if ch == ";":
            pieces.append((sql[start:i], start))
            start = i + 1
        i += 1
    pieces.append((sql[start:], start))
    return [(text, off) for text, off in pieces if _has_code(text)]


def _has_code(text):
    stripped = re.sub(r"--[^\n]*|/\*.*?\*/", "", text, flags=re.S)
    return bool(stripped.strip())


def to_json_value(v):
    if v is None or isinstance(v, (bool, str)):
        return v
    if isinstance(v, int):
        return str(v) if abs(v) > MAX_SAFE_INT else v
    if isinstance(v, float):
        if v != v or v in (float("inf"), float("-inf")):
            return str(v)
        return v
    if isinstance(v, decimal.Decimal):
        f = float(v)
        return str(v) if abs(f) > MAX_SAFE_INT else f
    if isinstance(v, datetime.datetime):
        return v.isoformat(sep=" ")
    if isinstance(v, (datetime.date, datetime.time)):
        return v.isoformat()
    if isinstance(v, datetime.timedelta):
        return str(v)
    if isinstance(v, (bytes, bytearray, memoryview)):
        return bytes(v).hex()
    return str(v)


def _excel_cell_text(v):
    """Convert a calamine cell value into CSV text for DuckDB to sniff."""
    if v is None or v == "":
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float):
        return str(int(v)) if v.is_integer() and abs(v) < 1e15 else repr(v)
    if isinstance(v, datetime.datetime):
        return v.isoformat(sep=" ")
    if isinstance(v, (datetime.date, datetime.time)):
        return v.isoformat()
    return str(v)


def _is_numeric_type(t):
    t = t.upper()
    return any(k in t for k in ("INT", "DOUBLE", "FLOAT", "DECIMAL", "REAL", "NUMERIC"))


# ---------------------------------------------------------------- engine

class Engine:
    def __init__(self):
        self.con = duckdb.connect(":memory:")
        self.con.execute(f"CREATE SCHEMA IF NOT EXISTS {RESULT_SCHEMA}")
        self.sources = {}  # table name -> {path, kind, sheet, options, mtime}
        self.results = {}  # result id -> {columns, total}
        self.running = {}  # tab id -> cursor
        self.lock = threading.Lock()
        self.tmpdir = tempfile.mkdtemp(prefix="quacksheet_")

    def cursor(self):
        return self.con.cursor()

    # ------------------------------------------------------------ loading

    def inspect_files(self, paths):
        """Describe files before import: kind, size, sheets and suggested table names."""
        taken = set(self._table_names())
        out = []
        for path in paths:
            item = {"path": path, "name": os.path.basename(path), "kind": file_kind(path), "tables": []}
            try:
                item["size"] = os.path.getsize(path)
                stem = sanitize_name(os.path.splitext(os.path.basename(path))[0])
                if item["kind"] == "excel":
                    from python_calamine import CalamineWorkbook

                    wb = CalamineWorkbook.from_path(path)
                    sheets = list(wb.sheet_names)
                    for sheet in sheets:
                        base = stem if len(sheets) == 1 else f"{stem}_{sanitize_name(sheet)}"
                        item["tables"].append({
                            "sheet": sheet,
                            "table": self._unique(base, taken),
                            "header_row": self._guess_header_row(wb, sheet),
                        })
                else:
                    item["tables"].append({"sheet": None, "table": self._unique(stem, taken)})
            except Exception as e:  # noqa: BLE001
                item["error"] = str(e)
            out.append(item)
        return out

    @staticmethod
    def _guess_header_row(wb, sheet):
        """First row (1-based) within the top 30 having the most filled cells; skips title/notes rows."""
        try:
            counts = []
            for i, row in enumerate(wb.get_sheet_by_name(sheet).iter_rows()):
                if i >= 30:
                    break
                counts.append(sum(1 for v in row if v not in (None, "")))
            if not counts or max(counts) == 0:
                return 1
            return counts.index(max(counts)) + 1
        except Exception:  # noqa: BLE001
            return 1

    @staticmethod
    def _unique(base, taken):
        name, n = base, 2
        while name in taken:
            name = f"{base}_{n}"
            n += 1
        taken.add(name)
        return name

    def load_table(self, path, kind, sheet, table, options):
        """(Re)create `table` from a file. Options: delimiter, header, skip, encoding, all_text, header_row."""
        options = options or {}
        table = table.strip()
        if not table:
            raise QueryError("Table name is empty")
        if not os.path.exists(path):
            raise QueryError(f"File not found: {path}")
        cur = self.cursor()
        tmp_csv = None
        try:
            if kind == "excel":
                tmp_csv = self._excel_to_csv(path, sheet, options)
                reader = self._read_csv_sql(tmp_csv, {"delimiter": ",", "header": True, "all_text": options.get("all_text")})
            elif kind == "parquet":
                reader = f"read_parquet({quote_str(path)})"
            elif kind == "json":
                reader = f"read_json_auto({quote_str(path)})"
            else:
                reader = self._read_csv_sql(path, options)
            cur.execute(f"CREATE OR REPLACE TABLE {quote_ident(table)} AS SELECT * FROM {reader}")
            rows = cur.execute(f"SELECT count(*) FROM {quote_ident(table)}").fetchone()[0]
        except duckdb.Error as e:
            raise QueryError(str(e)) from None
        finally:
            cur.close()
            if tmp_csv and os.path.exists(tmp_csv):
                os.remove(tmp_csv)
        self.sources[table] = {
            "path": path,
            "kind": kind,
            "sheet": sheet,
            "options": options,
            "mtime": os.path.getmtime(path),
        }
        return {"table": table, "rows": rows}

    @staticmethod
    def _read_csv_sql(path, o):
        args = [quote_str(path), "sample_size=-1"]
        delim = o.get("delimiter") or "auto"
        if delim != "auto":
            args.append(f"delim={quote_str(chr(9) if delim == 'tab' else delim)}")
        args.append(f"header={'true' if o.get('header', True) else 'false'}")
        skip = int(o.get("skip") or 0)
        if skip:
            args.append(f"skip={skip}")
        enc = o.get("encoding") or "utf-8"
        if enc != "utf-8":
            args.append(f"encoding={quote_str(enc)}")
        if o.get("all_text"):
            args.append("all_varchar=true")
        return f"read_csv({', '.join(args)})"

    def _excel_to_csv(self, path, sheet, options):
        from python_calamine import CalamineWorkbook

        header_row = max(int(options.get("header_row") or 1), 1)
        wb = CalamineWorkbook.from_path(path)
        ws = wb.get_sheet_by_name(sheet) if sheet else wb.get_sheet_by_index(0)
        rows = ws.iter_rows()
        for _ in range(header_row - 1):
            next(rows, None)
        header = next(rows, None)
        if header is None:
            raise QueryError(f"Sheet '{sheet}' has no rows at header row {header_row}")
        header = [_excel_cell_text(h).strip() for h in header]
        width = len(header)
        while width and not header[width - 1]:
            width -= 1
        if width == 0:
            raise QueryError(f"Header row {header_row} of sheet '{sheet}' is empty")
        names, seen = [], {}
        for i, h in enumerate(header[:width]):
            h = h or f"column_{i + 1}"
            if h.lower() in seen:
                seen[h.lower()] += 1
                h = f"{h}_{seen[h.lower()]}"
            seen[h.lower()] = seen.get(h.lower(), 1)
            names.append(h)
        out = os.path.join(self.tmpdir, f"{uuid.uuid4().hex}.csv")
        with open(out, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(names)
            for row in rows:
                vals = [_excel_cell_text(v) for v in row[:width]]
                if not any(vals):
                    continue
                vals.extend([""] * (width - len(vals)))
                w.writerow(vals)
        return out

    def reload_table(self, table):
        src = self.sources.get(table)
        if not src:
            raise QueryError(f"'{table}' was not loaded from a file")
        return self.load_table(src["path"], src["kind"], src["sheet"], table, src["options"])

    def drop_table(self, table):
        cur = self.cursor()
        try:
            kind = cur.execute(
                "SELECT table_type FROM information_schema.tables WHERE table_schema='main' AND table_name=?",
                [table],
            ).fetchone()
            stmt = "DROP VIEW" if kind and kind[0] == "VIEW" else "DROP TABLE"
            cur.execute(f"{stmt} IF EXISTS {quote_ident(table)}")
        finally:
            cur.close()
        self.sources.pop(table, None)

    def rename_table(self, old, new):
        new = new.strip()
        if not new:
            raise QueryError("Table name is empty")
        cur = self.cursor()
        try:
            cur.execute(f"ALTER TABLE {quote_ident(old)} RENAME TO {quote_ident(new)}")
        except duckdb.Error as e:
            raise QueryError(str(e)) from None
        finally:
            cur.close()
        if old in self.sources:
            self.sources[new] = self.sources.pop(old)
        return new

    def changed_sources(self):
        changed = []
        for table, src in self.sources.items():
            try:
                if os.path.getmtime(src["path"]) != src["mtime"]:
                    changed.append(table)
            except OSError:
                changed.append(table)
        return changed

    def get_sources(self):
        return [
            {"table": t, "path": s["path"], "kind": s["kind"], "sheet": s["sheet"], "options": s["options"]}
            for t, s in self.sources.items()
        ]

    def clear_all(self):
        for table in self._table_names():
            self.drop_table(table)
        self.sources.clear()

    # ------------------------------------------------------------ schema

    def _table_names(self):
        cur = self.cursor()
        try:
            return [
                r[0]
                for r in cur.execute(
                    "SELECT table_name FROM information_schema.tables WHERE table_schema='main'"
                ).fetchall()
            ]
        finally:
            cur.close()

    def get_schema(self):
        cur = self.cursor()
        try:
            tables = cur.execute(
                "SELECT table_name, table_type FROM information_schema.tables "
                "WHERE table_schema='main' ORDER BY table_name"
            ).fetchall()
            cols = cur.execute(
                "SELECT table_name, column_name, data_type FROM information_schema.columns "
                "WHERE table_schema='main' ORDER BY table_name, ordinal_position"
            ).fetchall()
            by_table = {}
            for t, c, typ in cols:
                by_table.setdefault(t, []).append({"name": c, "type": typ})
            changed = set(self.changed_sources())
            out = []
            for name, ttype in tables:
                rows = None
                if ttype != "VIEW":
                    rows = cur.execute(f"SELECT count(*) FROM {quote_ident(name)}").fetchone()[0]
                src = self.sources.get(name)
                out.append(
                    {
                        "name": name,
                        "type": "view" if ttype == "VIEW" else "table",
                        "rows": rows,
                        "columns": by_table.get(name, []),
                        "source": {"path": src["path"], "sheet": src["sheet"]} if src else None,
                        "changed": name in changed,
                    }
                )
            return out
        finally:
            cur.close()

    def get_completions(self):
        cur = self.cursor()
        try:
            funcs = [
                r[0]
                for r in cur.execute(
                    "SELECT DISTINCT function_name FROM duckdb_functions() "
                    "WHERE function_name NOT LIKE '%\\_%' ESCAPE '\\' OR function_name ~ '^[a-z]' ORDER BY 1"
                ).fetchall()
                if re.match(r"^[a-z][a-z0-9_]*$", r[0])
            ]
            kw = cur.execute("SELECT keyword_name, keyword_category FROM duckdb_keywords()").fetchall()
            return {
                "functions": funcs,
                "keywords": [k.upper() for k, _ in kw],
                "reserved": [k.upper() for k, cat in kw if cat == "reserved"],
            }
        finally:
            cur.close()

    # ------------------------------------------------------------ queries

    def run(self, tab_id, sql):
        """Run all statements; the last one's rows are stored in a result table for paging/export."""
        statements = split_statements(sql)
        if not statements:
            raise QueryError("Nothing to run")
        cur = self.cursor()
        self.running[tab_id] = cur
        t0 = time.perf_counter()
        result = {"ok": True, "statements": len(statements), "schema_changed": False}
        try:
            for idx, (text, offset) in enumerate(statements):
                is_last = idx == len(statements) - 1
                try:
                    if is_last:
                        result.update(self._run_last(cur, text))
                    else:
                        cur.execute(text)
                        result["schema_changed"] = True
                except duckdb.InterruptException:
                    raise QueryError("Query cancelled") from None
                except duckdb.Error as e:
                    raise self._located_error(e, sql, text, offset, idx) from None
            if not result.get("result_id"):
                result["schema_changed"] = True
        finally:
            self.running.pop(tab_id, None)
            cur.close()
        result["elapsed_ms"] = round((time.perf_counter() - t0) * 1000, 1)
        return result

    def _run_last(self, cur, text):
        rid = "r_" + uuid.uuid4().hex[:12]
        target = f"{RESULT_SCHEMA}.{quote_ident(rid)}"
        body = text.strip()
        attempts = []
        if not _WRAP_ONLY.match(body):
            attempts.append(f"CREATE TABLE {target} AS ")
        attempts.append(f"CREATE TABLE {target} AS SELECT * FROM (")
        first_error = None
        for prefix in attempts:
            stmt = prefix + body + ("\n)" if prefix.endswith("(") else "\n")
            try:
                cur.execute(stmt)
                break
            except duckdb.Error as e:
                e.qs_exec = (stmt, len(prefix), True)
                # Parser errors may just mean the wrapper doesn't fit; binder/catalog errors are real.
                if isinstance(e, duckdb.ParserException) or "Parser Error" in str(e):
                    first_error = first_error or e
                else:
                    raise
        else:
            # Not a query (CREATE, INSERT, SET, ...): run as-is.
            if first_error is not None and not self._is_query_like(body):
                res = cur.execute(text)
                info = {"message": "Statement executed", "schema_changed": True}
                if res.description:
                    rows = res.fetchall()
                    if len(rows) == 1 and len(rows[0]) == 1 and res.description[0][0] == "Count":
                        info["message"] = f"{rows[0][0]:,} row(s) affected"
                return info
            raise first_error
        cols = cur.execute(
            "SELECT column_name, data_type FROM information_schema.columns "
            "WHERE table_schema=? AND table_name=? ORDER BY ordinal_position",
            [RESULT_SCHEMA, rid],
        ).fetchall()
        total = cur.execute(f"SELECT count(*) FROM {target}").fetchone()[0]
        columns = [{"name": c, "type": t, "numeric": _is_numeric_type(t)} for c, t in cols]
        with self.lock:
            self.results[rid] = {"columns": columns, "total": total}
        return {"result_id": rid, "columns": columns, "total_rows": total}

    @staticmethod
    def _is_query_like(body):
        head = re.sub(r"^(\s|--[^\n]*\n|/\*.*?\*/)*", "", body, flags=re.S).split(None, 1)
        word = head[0].lower() if head else ""
        return word in {"select", "with", "from", "values", "table", "pivot", "unpivot", "(",
                        "describe", "summarize", "show"}

    @staticmethod
    def _located_error(err, full_sql, text, offset, idx):
        """Map DuckDB's "LINE n: ... ^" marker back to a line/column in the editor text."""
        msg = str(err)
        line = col = None
        # exec_text is what DuckDB saw: optional prefix + statement body (body starts at body_start in full_sql).
        exec_text, prefix_len, stripped = getattr(err, "qs_exec", (text, 0, False))
        body_start = offset + (len(text) - len(text.lstrip()) if stripped else 0)
        m = _ERR_LINE.search(msg)
        if m:
            rel_line = int(m.group(1))
            caret = len(m.group(3)) - len(f"LINE {m.group(1)}: ")
            snippet = m.group(2)
            lead = 3 if snippet.startswith("...") else 0
            probe = snippet[lead:]
            if probe.endswith("..."):
                probe = probe[:-3]
            exec_lines = exec_text.split("\n")
            if 0 < rel_line <= len(exec_lines):
                src = exec_lines[rel_line - 1]
                pos = src.find(probe) if probe else -1
                col_exec = caret if pos < 0 else pos + caret - lead
                before = full_sql[:body_start]
                line = before.count("\n") + rel_line
                if rel_line == 1:
                    col = len(before.split("\n")[-1]) + max(col_exec - prefix_len, 0) + 1
                else:
                    col = col_exec + 1
            msg = msg[: m.start()].rstrip()
        e = QueryError(msg)
        e.line, e.column, e.statement = line, col, idx + 1
        return e

    def cancel(self, tab_id):
        cur = self.running.get(tab_id)
        if cur is not None:
            cur.interrupt()
            return True
        return False

    def _view_sql(self, rid, sort=None, filters=None):
        info = self.results.get(rid)
        if info is None:
            raise QueryError("Result has expired; run the query again")
        cols = info["columns"]
        where, params = [], []
        for f in filters or []:
            ci = int(str(f["field"]).lstrip("c"))
            col = cols[ci]
            ident = quote_ident(col["name"])
            val = str(f.get("value", "")).strip()
            if not val:
                continue
            m = re.match(r"^(>=|<=|<>|!=|=|>|<)\s*(.+)$", val)
            if val.lower() in ("null", "is null"):
                where.append(f"{ident} IS NULL")
            elif val.lower() in ("not null", "is not null", "!null"):
                where.append(f"{ident} IS NOT NULL")
            elif m:
                op = "<>" if m.group(1) == "!=" else m.group(1)
                rhs = m.group(2)
                if col["numeric"]:
                    try:
                        float(rhs)
                        where.append(f"{ident} {op} ?")
                        params.append(float(rhs))
                        continue
                    except ValueError:
                        pass
                where.append(f"CAST({ident} AS VARCHAR) {op} ?")
                params.append(rhs)
            else:
                where.append(f"CAST({ident} AS VARCHAR) ILIKE ?")
                params.append(f"%{val}%")
        sql = f"SELECT * FROM {RESULT_SCHEMA}.{quote_ident(rid)}"
        if where:
            sql += " WHERE " + " AND ".join(where)
        order = []
        for s in sort or []:
            ci = int(str(s["field"]).lstrip("c"))
            direction = "DESC" if s.get("dir") == "desc" else "ASC"
            order.append(f"{quote_ident(cols[ci]['name'])} {direction} NULLS LAST")
        if order:
            sql += " ORDER BY " + ", ".join(order)
        return sql, params

    def fetch_page(self, rid, page, size, sort=None, filters=None):
        sql, params = self._view_sql(rid, sort, filters)
        page, size = max(int(page), 1), max(int(size), 1)
        cur = self.cursor()
        try:
            if filters:
                total = cur.execute(f"SELECT count(*) FROM ({sql})", params).fetchone()[0]
            else:
                total = self.results[rid]["total"]
            rows = cur.execute(f"{sql} LIMIT {size} OFFSET {(page - 1) * size}", params).fetchall()
        except duckdb.Error as e:
            raise QueryError(str(e)) from None
        finally:
            cur.close()
        data = [{f"c{i}": to_json_value(v) for i, v in enumerate(r)} for r in rows]
        last_page = max((total + size - 1) // size, 1)
        return {"data": data, "last_page": last_page, "total": total}

    def discard_result(self, rid):
        with self.lock:
            self.results.pop(rid, None)
        cur = self.cursor()
        try:
            cur.execute(f"DROP TABLE IF EXISTS {RESULT_SCHEMA}.{quote_ident(rid)}")
        finally:
            cur.close()

    # ------------------------------------------------------------ profiling

    def profile_column(self, relation, column):
        """relation: {'table': name} or {'result_id': rid}."""
        if relation.get("result_id"):
            rel = f"{RESULT_SCHEMA}.{quote_ident(relation['result_id'])}"
        else:
            rel = quote_ident(relation["table"])
        c = quote_ident(column)
        cur = self.cursor()
        try:
            typ = cur.execute(f"SELECT typeof({c}) FROM {rel} LIMIT 1").fetchone()
            typ = typ[0] if typ else "?"
            stats = cur.execute(
                f"SELECT count(*), count({c}), approx_count_distinct({c}), "
                f"CAST(min({c}) AS VARCHAR), CAST(max({c}) AS VARCHAR) FROM {rel}"
            ).fetchone()
            out = {
                "column": column,
                "type": typ,
                "rows": stats[0],
                "non_null": stats[1],
                "nulls": stats[0] - stats[1],
                "distinct": stats[2],
                "min": stats[3],
                "max": stats[4],
            }
            if _is_numeric_type(typ):
                num = cur.execute(
                    f"SELECT avg({c}), median({c}), stddev({c}), sum({c}) FROM {rel}"
                ).fetchone()
                out.update(
                    {"avg": to_json_value(num[0]), "median": to_json_value(num[1]),
                     "stddev": to_json_value(num[2]), "sum": to_json_value(num[3])}
                )
            else:
                ln = cur.execute(
                    f"SELECT min(length(CAST({c} AS VARCHAR))), max(length(CAST({c} AS VARCHAR))) FROM {rel}"
                ).fetchone()
                out.update({"min_length": ln[0], "max_length": ln[1]})
            top = cur.execute(
                f"SELECT CAST({c} AS VARCHAR) v, count(*) n FROM {rel} GROUP BY 1 ORDER BY n DESC, v LIMIT 15"
            ).fetchall()
            out["top"] = [{"value": v, "count": n} for v, n in top]
            return out
        except duckdb.Error as e:
            raise QueryError(str(e)) from None
        finally:
            cur.close()

    # ------------------------------------------------------------ export

    def export(self, rid, path, fmt, sort=None, filters=None, progress=None):
        sql, params = self._view_sql(rid, sort, filters)
        cur = self.cursor()
        try:
            if fmt == "csv":
                cur.execute(f"COPY ({sql}) TO {quote_str(path)} (HEADER, DELIMITER ',')", params)
            elif fmt == "parquet":
                cur.execute(f"COPY ({sql}) TO {quote_str(path)} (FORMAT PARQUET)", params)
            elif fmt == "xlsx":
                self.export_workbook(
                    [{"result_id": rid, "sheet": "Results", "sort": sort, "filters": filters}], path, progress
                )
            else:
                raise QueryError(f"Unknown format {fmt}")
        except duckdb.Error as e:
            raise QueryError(str(e)) from None
        finally:
            cur.close()
        return {"path": path}

    def export_workbook(self, items, path, progress=None):
        """Write several results into one .xlsx, one sheet each (split if over Excel's row limit)."""
        import xlsxwriter

        wb = xlsxwriter.Workbook(path, {"constant_memory": True, "strings_to_formulas": False,
                                        "strings_to_urls": False, "strings_to_numbers": False})
        fmts = {
            "header": wb.add_format({"bold": True, "bg_color": "#E8EEF7", "border": 1}),
            "date": wb.add_format({"num_format": "yyyy-mm-dd"}),
            "datetime": wb.add_format({"num_format": "yyyy-mm-dd hh:mm:ss"}),
            "time": wb.add_format({"num_format": "hh:mm:ss"}),
        }
        used = set()
        written, last_report = 0, time.perf_counter()
        cur = self.cursor()
        try:
            for item in items:
                sql, params = self._view_sql(item["result_id"], item.get("sort"), item.get("filters"))
                columns = [c["name"] for c in self.results[item["result_id"]]["columns"]]
                res = cur.execute(sql, params)
                base = self._sheet_name(item.get("sheet") or "Results")
                part = 1
                batch = res.fetchmany(2000)
                while True:
                    name = base if part == 1 else f"{base[:26]} ({part})"
                    name = self._dedupe_sheet(name, used)
                    ws = wb.add_worksheet(name)
                    self._set_widths(ws, columns, batch)
                    for ci, col in enumerate(columns):
                        ws.write_string(0, ci, col, fmts["header"])
                    ws.freeze_panes(1, 0)
                    r = 1
                    full = False
                    while batch:
                        room = EXCEL_MAX_ROWS - r
                        chunk, rest = batch[:room], batch[room:]
                        for row in chunk:
                            for ci, v in enumerate(row):
                                self._write_cell(ws, r, ci, v, fmts)
                            r += 1
                        written += len(chunk)
                        if progress and time.perf_counter() - last_report > 0.5:
                            last_report = time.perf_counter()
                            progress(written)
                        if rest or r >= EXCEL_MAX_ROWS:
                            batch = rest or res.fetchmany(2000)
                            full = bool(batch)
                            break
                        batch = res.fetchmany(2000)
                    ws.autofilter(0, 0, max(r - 1, 0), max(len(columns) - 1, 0))
                    if not full:
                        break
                    part += 1
        finally:
            cur.close()
            wb.close()
        return {"path": path}

    @staticmethod
    def _sheet_name(name):
        name = re.sub(r"[\[\]:*?/\\]", "_", str(name)).strip("'") or "Sheet"
        return name[:31]

    @staticmethod
    def _dedupe_sheet(name, used):
        candidate, n = name, 2
        while candidate.lower() in used:
            suffix = f" {n}"
            candidate = name[: 31 - len(suffix)] + suffix
            n += 1
        used.add(candidate.lower())
        return candidate

    @staticmethod
    def _set_widths(ws, columns, sample):
        for ci, col in enumerate(columns):
            width = len(str(col))
            for row in sample[:500]:
                v = row[ci]
                if v is not None:
                    width = max(width, len(str(v)))
            ws.set_column(ci, ci, min(max(width + 2, 8), 60))

    @staticmethod
    def _write_cell(ws, r, c, v, fmts):
        if v is None:
            return
        if isinstance(v, bool):
            ws.write_boolean(r, c, v)
        elif isinstance(v, int):
            if abs(v) > 10**15:
                ws.write_string(r, c, str(v))
            else:
                ws.write_number(r, c, v)
        elif isinstance(v, float):
            if v != v or v in (float("inf"), float("-inf")):
                ws.write_string(r, c, str(v))
            else:
                ws.write_number(r, c, v)
        elif isinstance(v, decimal.Decimal):
            ws.write_number(r, c, float(v))
        elif isinstance(v, datetime.datetime):
            ws.write_datetime(r, c, v.replace(tzinfo=None), fmts["datetime"])
        elif isinstance(v, datetime.date):
            ws.write_datetime(r, c, v, fmts["date"])
        elif isinstance(v, datetime.time):
            ws.write_datetime(r, c, v.replace(tzinfo=None), fmts["time"])
        else:
            s = str(v) if not isinstance(v, str) else v
            ws.write_string(r, c, s[:32767])

    def close(self):
        try:
            self.con.close()
        finally:
            import shutil

            shutil.rmtree(self.tmpdir, ignore_errors=True)
