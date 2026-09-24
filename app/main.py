"""QuackSheet: load CSV/Excel files, query them with SQL (DuckDB), export results."""

import json
import os
import sys
import traceback

import webview
from webview.dom import DOMEventHandler

from engine import Engine, QueryError

APP_NAME = "QuackSheet"
DATA_FILES = "Data files (*.csv;*.tsv;*.txt;*.xlsx;*.xlsm;*.xls;*.xlsb;*.ods;*.parquet;*.json;*.jsonl)"
PROJECT_EXT = ".quack"


def app_data_dir():
    base = os.environ.get("APPDATA") or os.path.expanduser("~")
    path = os.path.join(base, APP_NAME)
    os.makedirs(path, exist_ok=True)
    return path


def _ok(**data):
    return {"ok": True, **data}


def _fail(err):
    out = {"ok": False, "error": str(err)}
    for attr in ("line", "column", "statement"):
        if getattr(err, attr, None) is not None:
            out[attr] = getattr(err, attr)
    if not isinstance(err, QueryError):
        traceback.print_exc()
    return out


def _first(path):
    if isinstance(path, (list, tuple)):
        return path[0] if path else None
    return path


class Api:
    """Methods exposed to JavaScript as window.pywebview.api.*"""

    def __init__(self):
        self._engine = Engine()
        self._window = None
        self._state_path = os.path.join(app_data_dir(), "state.json")

    # -- dialogs
    def pick_files(self):
        paths = self._window.create_file_dialog(
            webview.FileDialog.OPEN, allow_multiple=True, file_types=(DATA_FILES, "All files (*.*)")
        )
        return list(paths or [])

    def pick_save_path(self, default_name, fmt):
        types = {
            "csv": ("CSV file (*.csv)",),
            "xlsx": ("Excel workbook (*.xlsx)",),
            "parquet": ("Parquet file (*.parquet)",),
            "project": (f"QuackSheet project (*{PROJECT_EXT})",),
            "sql": ("SQL file (*.sql)",),
        }[fmt]
        path = _first(
            self._window.create_file_dialog(webview.FileDialog.SAVE, save_filename=default_name, file_types=types)
        )
        if not path:
            return None
        ext = PROJECT_EXT if fmt == "project" else "." + fmt
        if not path.lower().endswith(ext):
            path += ext
        return path

    # -- files and tables
    def inspect_files(self, paths):
        try:
            return _ok(files=self._engine.inspect_files(paths))
        except Exception as e:  # noqa: BLE001
            return _fail(e)

    def load_tables(self, items):
        """items: [{path, kind, sheet, table, options}] -> per-item results."""
        results = []
        for i, it in enumerate(items):
            self._progress(f"Loading {os.path.basename(it['path'])}"
                           + (f" [{it['sheet']}]" if it.get("sheet") else "") + f" ({i + 1}/{len(items)})")
            try:
                r = self._engine.load_table(it["path"], it["kind"], it.get("sheet"), it["table"], it.get("options"))
                results.append({"ok": True, **r})
            except Exception as e:  # noqa: BLE001
                results.append({"ok": False, "table": it.get("table"), "path": it["path"], "error": str(e)})
        self._progress(None)
        return results

    def reload_table(self, table):
        try:
            return _ok(**self._engine.reload_table(table))
        except Exception as e:  # noqa: BLE001
            return _fail(e)

    def drop_table(self, table):
        try:
            self._engine.drop_table(table)
            return _ok()
        except Exception as e:  # noqa: BLE001
            return _fail(e)

    def rename_table(self, old, new):
        try:
            return _ok(table=self._engine.rename_table(old, new))
        except Exception as e:  # noqa: BLE001
            return _fail(e)

    def get_schema(self):
        try:
            return _ok(tables=self._engine.get_schema())
        except Exception as e:  # noqa: BLE001
            return _fail(e)

    def get_completions(self):
        try:
            return _ok(**self._engine.get_completions())
        except Exception as e:  # noqa: BLE001
            return _fail(e)

    def check_changes(self):
        return self._engine.changed_sources()

    # -- queries
    def run_query(self, tab_id, sql):
        try:
            return self._engine.run(tab_id, sql)
        except Exception as e:  # noqa: BLE001
            return _fail(e)

    def cancel_query(self, tab_id):
        return self._engine.cancel(tab_id)

    def fetch_page(self, rid, page, size, sort, filters):
        try:
            return _ok(**self._engine.fetch_page(rid, page, size, sort, filters))
        except Exception as e:  # noqa: BLE001
            return _fail(e)

    def discard_result(self, rid):
        try:
            self._engine.discard_result(rid)
        except Exception:  # noqa: BLE001
            pass
        return True

    def profile_column(self, relation, column):
        try:
            return _ok(profile=self._engine.profile_column(relation, column))
        except Exception as e:  # noqa: BLE001
            return _fail(e)

    # -- export
    def export_result(self, rid, fmt, default_name, sort, filters):
        path = self.pick_save_path(default_name, fmt)
        if not path:
            return {"ok": False, "cancelled": True}
        try:
            self._progress("Exporting…")
            return _ok(**self._engine.export(rid, path, fmt, sort, filters, self._export_progress))
        except Exception as e:  # noqa: BLE001
            return _fail(e)
        finally:
            self._progress(None)

    def export_workbook(self, items, default_name):
        path = self.pick_save_path(default_name, "xlsx")
        if not path:
            return {"ok": False, "cancelled": True}
        try:
            self._progress("Exporting workbook…")
            return _ok(**self._engine.export_workbook(items, path, self._export_progress))
        except Exception as e:  # noqa: BLE001
            return _fail(e)
        finally:
            self._progress(None)

    def open_path(self, path):
        """Open a file or reveal it in Explorer."""
        try:
            if os.name == "nt":
                os.startfile(path)  # noqa: S606
            return True
        except OSError:
            return False

    def reveal_path(self, path):
        if os.name == "nt":
            import subprocess

            subprocess.Popen(["explorer", "/select,", os.path.normpath(path)])  # noqa: S603, S607
        return True

    # -- persisted UI state (tabs, history, saved queries, settings)
    def load_state(self):
        try:
            with open(self._state_path, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    def save_state(self, state):
        tmp = self._state_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f)
        os.replace(tmp, self._state_path)
        return True

    # -- projects
    def save_project(self, tabs, current_path):
        path = current_path or self.pick_save_path("project" + PROJECT_EXT, "project")
        if not path:
            return {"ok": False, "cancelled": True}
        project = {"app": APP_NAME, "version": 1, "sources": self._engine.get_sources(), "tabs": tabs}
        try:
            with open(path, "w", encoding="utf-8") as f:
                json.dump(project, f, indent=2)
            return _ok(path=path)
        except OSError as e:
            return _fail(e)

    def open_project(self):
        path = _first(
            self._window.create_file_dialog(
                webview.FileDialog.OPEN, file_types=(f"QuackSheet project (*{PROJECT_EXT})", "All files (*.*)")
            )
        )
        if not path:
            return {"ok": False, "cancelled": True}
        try:
            with open(path, encoding="utf-8") as f:
                project = json.load(f)
        except (OSError, ValueError) as e:
            return _fail(e)
        self._engine.clear_all()
        results = self.load_tables(project.get("sources", []))
        return _ok(path=path, tabs=project.get("tabs", []), loads=results)

    def save_sql_file(self, sql, default_name):
        path = self.pick_save_path(default_name, "sql")
        if not path:
            return {"ok": False, "cancelled": True}
        with open(path, "w", encoding="utf-8") as f:
            f.write(sql)
        return _ok(path=path)

    def open_sql_file(self):
        path = _first(
            self._window.create_file_dialog(
                webview.FileDialog.OPEN, file_types=("SQL files (*.sql;*.txt)", "All files (*.*)")
            )
        )
        if not path:
            return {"ok": False, "cancelled": True}
        with open(path, encoding="utf-8-sig") as f:
            return _ok(path=path, name=os.path.basename(path), sql=f.read())

    # -- internals
    def _export_progress(self, rows):
        self._progress(f"Writing Excel file… {rows:,} rows")

    def _progress(self, message):
        if self._window:
            self._window.evaluate_js(f"window.App && App.onProgress({json.dumps(message)})")


def _bind_drop(window, api):
    def on_drop(event):
        files = event.get("dataTransfer", {}).get("files", [])
        paths = [f.get("pywebviewFullPath") for f in files if f.get("pywebviewFullPath")]
        if paths:
            window.evaluate_js(f"App.onFilesDropped({json.dumps(paths)})")

    def noop(_event):
        pass

    doc = window.dom.document
    doc.events.dragenter += DOMEventHandler(noop, True, True)
    doc.events.dragover += DOMEventHandler(noop, True, True, debounce=500)
    doc.events.drop += DOMEventHandler(on_drop, True, True)


def main():
    api = Api()
    debug = "--debug" in sys.argv
    window = webview.create_window(
        APP_NAME,
        "web/index.html",
        js_api=api,
        width=1400,
        height=900,
        min_size=(900, 600),
        text_select=True,
    )
    api._window = window
    window.events.loaded += lambda: _bind_drop(window, api)
    window.events.closed += lambda: api._engine.close()
    webview.start(debug=debug, private_mode=False, storage_path=os.path.join(app_data_dir(), "webview"))


if __name__ == "__main__":
    main()
