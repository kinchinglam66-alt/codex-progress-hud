import importlib.util
import json
import pathlib
import sqlite3
import unittest


MODULE_PATH = pathlib.Path(__file__).parents[2] / "scripts" / "evaluation" / "sql-workloads.py"
SPEC = importlib.util.spec_from_file_location("sql_workloads", MODULE_PATH)
sql_workloads = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(sql_workloads)


def canonical_sql(key):
    family = int(key.split("_")[2])
    variant = int(key.split("_")[-1])
    if family == 0:
        return f"SELECT region, SUM(amount) AS total FROM sales WHERE amount >= {5 + variant} GROUP BY region ORDER BY region"
    if family == 1:
        return """
            SELECT customer_id, event, value FROM (
                SELECT customer_id, event, value,
                       ROW_NUMBER() OVER (
                           PARTITION BY customer_id ORDER BY occurred_at DESC, id DESC
                       ) AS rn
                FROM events
            ) WHERE rn = 1 ORDER BY customer_id
        """
    if family == 2:
        return f"""
            SELECT c.id FROM customers AS c
            WHERE NOT EXISTS (
                SELECT 1 FROM purchases AS p
            WHERE p.customer_id = c.id AND p.amount >= {4 + variant}
            ) ORDER BY c.id
        """
    if family == 3:
        return """
            SELECT account_id, id, amount,
                   SUM(amount) OVER (
                       PARTITION BY account_id ORDER BY occurred_at, id
                       ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                   ) AS running_total
            FROM ledger ORDER BY account_id, occurred_at, id
        """
    if family == 4:
        return """
            WITH RECURSIVE ordered AS (
                SELECT group_id, start_at, end_at,
                       MAX(end_at) OVER (
                           PARTITION BY group_id ORDER BY start_at, end_at
                           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                       ) AS prior_end
                FROM intervals
            ), marked AS (
                SELECT *, CASE WHEN prior_end IS NULL OR start_at > prior_end THEN 1 ELSE 0 END AS new_island
                FROM ordered
            ), numbered AS (
                SELECT *, SUM(new_island) OVER (PARTITION BY group_id ORDER BY start_at, end_at
                    ROWS UNBOUNDED PRECEDING) AS island_no
                FROM marked
            )
            SELECT group_id, MIN(start_at), MAX(end_at)
            FROM numbered GROUP BY group_id, island_no
            ORDER BY group_id, MIN(start_at)
        """
    if family == 5:
        return f"""
            WITH RECURSIVE reach(node, distance) AS (
                SELECT {variant % 4 + 1}, 0
                UNION
                SELECT e.dst, reach.distance + 1
                FROM reach JOIN edges AS e ON e.src = reach.node
                WHERE reach.distance < 8
            )
            SELECT node, MIN(distance) AS distance FROM reach
            GROUP BY node ORDER BY node
        """
    raise AssertionError(key)


class SqlWorkloadsTests(unittest.TestCase):
    def test_manifest_is_deterministic_and_has_expected_splits(self):
        first = sql_workloads.manifest()
        second = sql_workloads.manifest()
        self.assertEqual(first, second)
        self.assertEqual(len(first), 60)
        self.assertEqual(len({item["key"] for item in first}), 60)
        self.assertEqual(first[0]["key"], "sample_sql_0_0")
        self.assertTrue(all(item["key"] == f"sample_sql_{item['family']}_{int(item['key'].split('_')[-1])}" for item in first))
        self.assertEqual({item["split"] for item in first}, {"train", "calibration", "test"})
        self.assertEqual(sum(item["split"] == "train" for item in first), 20)
        self.assertEqual(sum(item["split"] == "calibration" for item in first), 10)
        self.assertEqual(sum(item["split"] == "test" for item in first), 30)
        self.assertTrue(all("Schema" in item["prompt"] and "Requirement" in item["prompt"] for item in first))
        self.assertFalse(any("SELECT" in item["prompt"].upper() for item in first))

    def test_each_family_has_hand_checked_oracle_case(self):
        for key in ("sample_sql_0_0", "sample_sql_1_0", "sample_sql_2_0", "sample_sql_3_0", "sample_sql_4_0", "sample_sql_5_0"):
            result = sql_workloads.validate(key, canonical_sql(key))
            self.assertTrue(result["passed"], (key, result))
            self.assertEqual(result["cases"], 8)
            self.assertEqual(result["passedCases"], 8)

    def test_all_canonical_queries_pass_all_sixty_tasks(self):
        for item in sql_workloads.manifest():
            result = sql_workloads.validate(item["key"], canonical_sql(item["key"]))
            self.assertTrue(result["passed"], (item["key"], result))
            self.assertEqual(result["passedCases"], result["cases"])

    def test_wrong_queries_fail(self):
        for family in range(6):
            key = f"sample_sql_{family}_0"
            result = sql_workloads.validate(key, "SELECT NULL")
            self.assertFalse(result["passed"], (key, result))
            self.assertIn(result["error"], {None, "execution_error"})

    def test_sqlite_safety_and_single_statement(self):
        unsafe = [
            "ATTACH DATABASE ':memory:' AS x",
            "PRAGMA user_version",
            "CREATE TABLE nope(x)",
            "SELECT load_extension('x')",
            "SELECT 1; SELECT 2",
        ]
        for sql in unsafe:
            result = sql_workloads.validate("sample_sql_0_0", sql)
            self.assertFalse(result["passed"])
            self.assertIn(result["error"], {"forbidden_operation", "multiple_statements", "execution_error"})

    def test_invalid_keys_and_overlong_sql_are_bounded(self):
        self.assertEqual(sql_workloads.validate("nope", "SELECT 1"), {
            "passed": False, "cases": 0, "passedCases": 0, "error": "invalid_key"
        })
        result = sql_workloads.validate("sample_sql_0_0", "SELECT 1" * 9000)
        self.assertEqual(result["error"], "sql_too_long")

    def test_cli_shapes_are_json_and_errors_are_not_raw(self):
        self.assertIsInstance(sql_workloads._cli_manifest(), list)
        response = sql_workloads._cli_validate(json.dumps({"key": "sample_sql_0_0", "sql": "SELECT 1"}))
        self.assertEqual(set(response), {"passed", "cases", "passedCases", "error"})
        self.assertNotIn("Traceback", json.dumps(response))

    def test_prompts_and_fixture_inputs_vary_by_seed(self):
        items = sql_workloads.manifest()
        for family in range(6):
            family_items = [item for item in items if item["family"] == str(family)]
            self.assertGreater(len({item["prompt"] for item in family_items}), 1)
            task_rows = [sql_workloads._fixtures(family, variant) for variant in range(10)]
            self.assertGreater(len({repr(rows) for rows in task_rows}), 1)

    def test_graph_prompt_states_bounded_node_domain(self):
        prompt = next(item["prompt"] for item in sql_workloads.manifest() if item["family"] == "5")
        self.assertIn("1 and 16", prompt)
        self.assertIn("distance 8", prompt)

    def test_reference_sql_is_test_only_and_dangerous_functions_are_denied(self):
        self.assertFalse(hasattr(sql_workloads, "_sample_sql"))
        for sql in ("SELECT readfile('x')", "SELECT writefile('x', 'y')", "SELECT load_extension('x')"):
            result = sql_workloads.validate("sample_sql_0_0", sql)
            self.assertFalse(result["passed"])
            self.assertEqual(result["error"], "forbidden_operation")
        self.assertEqual(sql_workloads._LIMITS_APPLIED, True)


if __name__ == "__main__":
    unittest.main()
