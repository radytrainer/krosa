#!/usr/bin/env python3
"""Prints an .xlsx workbook as JSON grids on stdout (used by verify-term-workbook.mjs).

Mirrors what the Google Sheets API returns: computed values, trailing empty cells and rows
removed. Needs openpyxl (pip install openpyxl). Nothing is written to disk.
"""
import json
import os
import sys

import openpyxl


def main() -> None:
    path = sys.argv[1]
    workbook = openpyxl.load_workbook(path, data_only=True, read_only=True)
    tabs = {}
    for sheet in workbook.worksheets:
        rows = []
        for row in sheet.iter_rows(values_only=True):
            cells = [
                v if v is None or isinstance(v, (int, float, str, bool)) else str(v) for v in row
            ]
            while cells and cells[-1] in (None, ""):
                cells.pop()
            rows.append(cells)
        while rows and not rows[-1]:
            rows.pop()
        tabs[sheet.title] = rows
    title = os.path.splitext(os.path.basename(path))[0]
    json.dump({"title": title, "tabs": tabs}, sys.stdout)


if __name__ == "__main__":
    main()
