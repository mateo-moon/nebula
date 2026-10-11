import copy
import json
import unittest

from canary_policy import compatible_policy, OCI_VERSIONS, RESOURCE_ANNOTATIONS


class CanaryPolicyTests(unittest.TestCase):
    def setUp(self):
        self.rules = "package agent_policy\ndefault CreateContainerRequest := false\n"
        self.data = {"containers": [
            {"OCI": {"Version": "1.1.0", "Process": {"Args": [command]}}, "runtime_anno_patterns": {}}
            for command in ("/pause", "/canary")], "common": {"preserve": "unchanged"}}

    def generated(self, data=None):
        return self.rules + "\npolicy_data := " + json.dumps(self.data if data is None else data)

    def test_exact_alternatives_preserve_all_upstream_rules_and_other_policy_data(self):
        result = compatible_policy(self.generated())
        rules, raw = result.split("\npolicy_data := ")
        self.assertEqual(rules, self.rules)
        data = json.loads(raw)
        self.assertEqual(data["common"], self.data["common"])
        self.assertEqual(len(data["containers"]), 2 * len(OCI_VERSIONS))
        for index, container in enumerate(data["containers"]):
            self.assertEqual(container["OCI"]["Version"], OCI_VERSIONS[index // 2])
            for key, value in RESOURCE_ANNOTATIONS.items():
                self.assertEqual(container["runtime_anno_patterns"].pop(key), value)
            container["OCI"]["Version"] = "1.1.0"
            self.assertEqual(container, self.data["containers"][index % 2])

    def test_upstream_changes_require_review(self):
        for path, value in [(('OCI', 'Version'), '1.4.0'), (('OCI', 'Process', 'Args'), ['/bin/sh']),
                            (('runtime_anno_patterns',), RESOURCE_ANNOTATIONS)]:
            data = copy.deepcopy(self.data)
            target = data['containers'][0]
            for key in path[:-1]:
                target = target[key]
            target[path[-1]] = value
            with self.subTest(path=path), self.assertRaises(ValueError):
                compatible_policy(self.generated(data))
        for containers in ([], self.data['containers'] * 2):
            with self.subTest(containers=len(containers)), self.assertRaises(ValueError):
                compatible_policy(self.generated({**self.data, 'containers': containers}))
        with self.assertRaises(ValueError):
            compatible_policy(self.generated() + '\npolicy_data := {}')


if __name__ == '__main__':
    unittest.main()
