"""Bounded, synthetic SQL workloads with an independent Python validator."""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
from collections import deque


MAX_SQL_BYTES = 8192
MAX_ROWS = 1000
_DEADLINE_SECONDS = 0.35
_LIMITS_APPLIED = False


def _split(family, variant):
    return "train" if family < 2 else "calibration" if family == 2 else "test"


def _prompt(family, variant):
    if family == 0:
        threshold = 5 + variant
        return ("Schema: sales has columns region (text) and amount (nullable integer).\n"
                f"Requirement: group sales by region, keep rows with amount at least {threshold}, "
                f"return region and the sum as total, ordered by region. Input seed: {variant}.")
    if family == 1:
        return ("Schema: events has columns customer_id (integer), event (nullable text), value (nullable integer), "
                "occurred_at (integer timestamp), and id (integer key).\n"
                "Requirement: return the latest row for every customer; break timestamp ties by the "
                f"largest id, returning customer_id, event, and value ordered by customer_id. Input seed: {variant}.")
    if family == 2:
        threshold = 4 + variant
        return ("Schema: customers has id (integer key); purchases has customer_id (integer) and amount (integer).\n"
                f"Requirement: return customers with no purchase amount at least {threshold}, ordered by id. Input seed: {variant}.")
    if family == 3:
        return ("Schema: ledger has account_id (integer), id (integer key), amount (nullable integer), and "
                "occurred_at (integer timestamp).\n"
                "Requirement: return every ledger row and a cumulative amount per account ordered by "
                f"occurred_at then id; the id tie-break must be explicit. NULL amounts add nothing and remain NULL until the first numeric amount. Return account_id, id, amount, running_total. Input seed: {variant}.")
    if family == 4:
        return ("Schema: intervals has group_id (integer), start_at (integer), and end_at (integer).\n"
                "Requirement: intervals have start_at less than or equal to end_at; merge overlapping or touching intervals within each group and return "
                f"group_id, merged start, and merged end ordered by group and start. Input seed: {variant}.")
    start = variant % 4 + 1
    return ("Schema: edges has directed integer columns src and dst.\n"
            f"Requirement: from start node {start}, return every reachable node and its shortest "
            "unweighted directed distance, including the start at distance zero, ordered by node. "
            f"All node ids are between 1 and 16; recursion is bounded at distance 8. Input seed: {variant}.")


def _make_task(family, variant):
    return {
        "key": f"sample_sql_{family}_{variant}",
        "family": str(family),
        "split": _split(family, variant),
        "prompt": _prompt(family, variant),
        "variant": variant,
        "family_no": family,
    }

def _fixtures(family, variant):
    shift = variant % 3
    if family == 0:
        return [
            [], [("east", 10 + shift), ("east", 5), ("west", 3)],
            [("north", None), ("north", 4)], [("south", 6 + shift)],
            [("west", 1), ("west", 2)], [(None, 9)], [("east", 5), ("east", 5)],
            [("north", None)],
        ]
    if family == 1:
        shift = variant % 3
        return [
            [], [(1, "old", 2, 10, 1), (1, "new", 3, 11, 2), (2, "only", 4, 1, 1)],
            [(1, "tie-low", 1 + shift, 20, 1), (1, "tie-high", 2 + shift, 20, 2)],
            [(3, None, None, 5, 1)], [(4, "a", 1, 2, 2), (4, "b", 2, 2, 1)],
            [(5, "x", 1, 0, 1), (5, "y", 2, -1, 2)], [(6, "one", 1, 7, 1)],
            [(7, "a", 1, 1, 1), (7, "b", 2, 1, 2), (7, "c", 3, 1, 3)],
        ]
    if family == 2:
        return [
            [], [(1,), (2,), (3,)], [(1,), (2,)], [(3,)],
            [(4,), (5,), (6,)], [(7,), (8 + variant,)], [(9,)], [(10,), (11 + variant,)],
        ]
    if family == 3:
        return [
            [], [(1, 1, 2, 1), (1, 2, 3, 1), (1, 3, None, 2)],
            [(2, 1, 5, 1), (2, 2, -2, 1)], [(3, 1, None, 1)],
            [(4, 1, 0, 0), (4, 2, 1 + shift, 0)], [(5, 1, 4, 4)],
            [(6, 2, 3, 1), (6, 1, 2, 1)], [(7, 1, None, 1), (7, 2, None, 1)],
        ]
    if family == 4:
        shift = variant % 3
        return [
            [], [(1, 1, 3), (1, 3, 5)], [(1, 1, 2), (1, 4, 6)],
            [(2, 5, 8), (2, 1, 2), (2, 2, 5)], [(3, 0, 1), (3, 1, 1)],
            [(4, 2 + shift, 4 + shift), (4, 3 + shift, 10 + shift), (4, 9 + shift, 12 + shift)], [(5, 1, 1)], [(6, 4, 4)],
        ]
    extra = (7 + variant, 7 + variant)
    return [
        [], [(1, 2), (2, 3), (1, 3), (3, 4)], [(1, 2), (2, 1)],
        [(2, 3), (3, 2), (3, 4), (4, 5)], [(1, 1)], [(2, 4)],
        [(1, 2), (1, 2), (2, 3), extra], [(3, 1), (1, 4)],
    ]


def _oracle(family, variant, rows):
    if family == 0:
        threshold = 5 + variant
        totals = {}
        for region, amount in rows:
            if amount is not None and amount >= threshold:
                totals[region] = totals.get(region, 0) + amount
        return [(region, totals[region]) for region in sorted(totals, key=lambda value: (value is not None, value))]
    if family == 1:
        latest = {}
        for customer, event, value, timestamp, row_id in rows:
            if customer not in latest or (timestamp, row_id) > (latest[customer][3], latest[customer][4]):
                latest[customer] = (customer, event, value, timestamp, row_id)
        return [(row[0], row[1], row[2]) for row in sorted(latest.values())]
    if family == 2:
        threshold = 4 + variant
        customers = [row[0] for row in rows]
        purchases = _purchase_rows(variant)
        qualifying = {customer for customer, amount in purchases if amount is not None and amount >= threshold}
        return [(customer,) for customer in sorted(customers) if customer not in qualifying]
    if family == 3:
        result = []
        for account in sorted({row[0] for row in rows}):
            running = 0
            has_value = False
            for _, row_id, amount, timestamp in sorted((r for r in rows if r[0] == account), key=lambda r: (r[3], r[1])):
                if amount is not None:
                    running += amount
                    has_value = True
                result.append((account, row_id, amount, running if has_value else None))
        return result
    if family == 4:
        result = []
        for group in sorted({row[0] for row in rows}):
            current = None
            for _, start, end in sorted((r for r in rows if r[0] == group), key=lambda r: (r[1], r[2])):
                if current is None or start > current[1]:
                    if current is not None:
                        result.append((group, current[0], current[1]))
                    current = [start, end]
                else:
                    current[1] = max(current[1], end)
            if current is not None:
                result.append((group, current[0], current[1]))
        return result
    start = variant % 4 + 1
    adjacency = {}
    for source, target in rows:
        adjacency.setdefault(source, []).append(target)
    distances = {start: 0}
    queue = deque([start])
    while queue:
        node = queue.popleft()
        if distances[node] >= 8:
            continue
        for target in adjacency.get(node, []):
            if target not in distances:
                distances[target] = distances[node] + 1
                queue.append(target)
    return [(node, distances[node]) for node in sorted(distances)]


def _purchase_rows(variant):
    threshold = 4 + variant
    return [(1, 3), (1, 7), (2, None), (3, 2), (4, 10), (99, 100)]


def _setup(connection, family, rows):
    connection.execute("PRAGMA foreign_keys = OFF")
    if family == 0:
        connection.execute("CREATE TABLE sales(region TEXT, amount INTEGER)")
        connection.executemany("INSERT INTO sales VALUES (?, ?)", rows)
    elif family == 1:
        connection.execute("CREATE TABLE events(customer_id INTEGER, event TEXT, value INTEGER, occurred_at INTEGER, id INTEGER)")
        connection.executemany("INSERT INTO events VALUES (?, ?, ?, ?, ?)", rows)
    elif family == 2:
        connection.execute("CREATE TABLE customers(id INTEGER)")
        connection.execute("CREATE TABLE purchases(customer_id INTEGER, amount INTEGER)")
        connection.executemany("INSERT INTO customers VALUES (?)", rows)
        connection.executemany("INSERT INTO purchases VALUES (?, ?)", _purchase_rows(0))
    elif family == 3:
        connection.execute("CREATE TABLE ledger(account_id INTEGER, id INTEGER, amount INTEGER, occurred_at INTEGER)")
        connection.executemany("INSERT INTO ledger VALUES (?, ?, ?, ?)", rows)
    elif family == 4:
        connection.execute("CREATE TABLE intervals(group_id INTEGER, start_at INTEGER, end_at INTEGER)")
        connection.executemany("INSERT INTO intervals VALUES (?, ?, ?)", rows)
    else:
        connection.execute("CREATE TABLE edges(src INTEGER, dst INTEGER)")
        connection.executemany("INSERT INTO edges VALUES (?, ?)", rows)


def _authorizer(action, arg1, arg2, db_name, source):
    if action == sqlite3.SQLITE_FUNCTION and (arg1 or arg2 or "").lower() in {
        "load_extension", "readfile", "writefile", "eval", "fts3_tokenizer"
    }:
        return sqlite3.SQLITE_DENY
    allowed = {sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ, sqlite3.SQLITE_FUNCTION, sqlite3.SQLITE_RECURSIVE}
    return sqlite3.SQLITE_OK if action in allowed else sqlite3.SQLITE_DENY


def _apply_limits(connection):
    global _LIMITS_APPLIED
    limits = {
        "SQLITE_LIMIT_LENGTH": 1_000_000,
        "SQLITE_LIMIT_SQL_LENGTH": MAX_SQL_BYTES,
        "SQLITE_LIMIT_VDBE_OP": 50_000,
        "SQLITE_LIMIT_EXPR_DEPTH": 1_000,
        "SQLITE_LIMIT_COMPOUND_SELECT": 100,
        "SQLITE_LIMIT_VARIABLE_NUMBER": 100,
    }
    for name, value in limits.items():
        category = getattr(sqlite3, name, None)
        if category is not None:
            connection.setlimit(category, value)
    _LIMITS_APPLIED = True


def _run_case(task, sql, rows):
    family, variant = task["family_no"], task["variant"]
    connection = sqlite3.connect(":memory:")
    try:
        _apply_limits(connection)
        _setup(connection, family, rows)
        connection.set_authorizer(_authorizer)
        deadline = time.monotonic() + _DEADLINE_SECONDS
        def progress():
            return 1 if time.monotonic() > deadline else 0
        connection.set_progress_handler(progress, 1000)
        cursor = connection.execute(sql)
        actual = cursor.fetchmany(MAX_ROWS + 1)
        if len(actual) > MAX_ROWS:
            return None, "too_many_rows"
        expected = _oracle(family, variant, rows if family != 2 else rows)
        return [tuple(row) for row in actual], (expected, None)
    except sqlite3.DatabaseError as exc:
        message = str(exc).lower()
        if "not authorized" in message or "prohibited" in message:
            return None, "forbidden_operation"
        if "one statement" in message:
            return None, "multiple_statements"
        if "interrupted" in message:
            return None, "deadline_exceeded"
        return None, "execution_error"
    finally:
        connection.close()


def _tasks():
    return [_make_task(family, variant) for family in range(6) for variant in range(10)]


_TASKS = {task["key"]: task for task in _tasks()}


def manifest():
    return [{"key": task["key"], "family": task["family"], "split": task["split"], "prompt": task["prompt"]} for task in _TASKS.values()]


def _cli_manifest():
    return manifest()


def validate(key, sql):
    if key not in _TASKS:
        return {"passed": False, "cases": 0, "passedCases": 0, "error": "invalid_key"}
    if not isinstance(sql, str):
        return {"passed": False, "cases": 0, "passedCases": 0, "error": "invalid_sql"}
    if len(sql.encode("utf-8")) > MAX_SQL_BYTES:
        return {"passed": False, "cases": 0, "passedCases": 0, "error": "sql_too_long"}
    lowered_sql = sql.lower()
    if any(name in lowered_sql for name in ("load_extension", "readfile", "writefile", "fts3_tokenizer", "eval(")):
        return {"passed": False, "cases": 0, "passedCases": 0, "error": "forbidden_operation"}
    task = _TASKS[key]
    passed = 0
    for rows in _fixtures(task["family_no"], task["variant"]):
        actual, expected_or_error = _run_case(task, sql, rows)
        if isinstance(expected_or_error, tuple):
            expected, error = expected_or_error
            if error:
                return {"passed": False, "cases": 8, "passedCases": passed, "error": error}
            if actual == expected:
                passed += 1
        else:
            return {"passed": False, "cases": 8, "passedCases": passed, "error": expected_or_error}
    return {"passed": passed == 8, "cases": 8, "passedCases": passed, "error": None}


def _cli_validate(payload):
    try:
        data = json.loads(payload)
        return validate(data.get("key"), data.get("sql"))
    except (TypeError, ValueError, AttributeError):
        return {"passed": False, "cases": 0, "passedCases": 0, "error": "invalid_request"}


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", action="store_true")
    parser.add_argument("--validate", action="store_true")
    args = parser.parse_args(argv)
    if args.manifest:
        print(json.dumps(manifest(), sort_keys=True))
    elif args.validate:
        print(json.dumps(_cli_validate(sys.stdin.read()), sort_keys=True))
    else:
        parser.error("choose --manifest or --validate")


if __name__ == "__main__":
    main()
