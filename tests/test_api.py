import json
import os
import unittest
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

from main import ANSWERS, create_api


ORIGIN = "https://www.arunavgupta.com"
HOSTNAME = "www.arunavgupta.com"


class AccessBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {"TYPESAFE_API_KEY": "private-test-key", "SECRET_KEY": "private-test-secret"})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.api = create_api()
        self.client = TestClient(self.api).__enter__()
        self.addCleanup(self.client.__exit__, None, None, None)
        self.calls = []
        self.verification = {"success": True, "hostname": HOSTNAME, "action": "ask"}
        self.upstream = {
            "model": "jev-test",
            "answers": {key: {"type": "noul", "noul": (index + 1) / 10} for index, (key, _) in enumerate(ANSWERS)},
        }
        self.upstream["answers"]["is_yes_no"] = {"type": "noul", "noul": 0.99}
        self.api.state.client = httpx.AsyncClient(transport=httpx.MockTransport(self.transport))
        self.addCleanup(self.client.portal.call, self.api.state.client.aclose)

    def transport(self, request):
        self.calls.append(request)
        if request.url.host == "challenges.cloudflare.com":
            return httpx.Response(200, json=self.verification)
        return httpx.Response(200, json=self.upstream)

    def ask(self, **overrides):
        return self.client.post("/ask", headers={"Origin": ORIGIN}, json={"question": "  Is the sun a star?  ", "turnstile_token": "single-use-token", **overrides})

    def test_request_logs_include_question_without_credentials(self):
        question = 'Is "yes" the answer?\nOr no?'
        with self.assertLogs("jev.requests", level="INFO") as captured:
            accepted = self.ask(question=question)
            self.verification["success"] = False
            rejected = self.ask(question=question)
        events = [json.loads(record.getMessage()) for record in captured.records]
        accepted_id = accepted.headers["x-request-id"]
        rejected_id = rejected.headers["x-request-id"]
        self.assertNotEqual(accepted_id, rejected_id)
        self.assertEqual({event["request_id"] for event in events}, {accepted_id, rejected_id})
        completed = {
            event["request_id"]: event["status_code"]
            for event in events if event["event"] == "http.completed"
        }
        self.assertEqual(completed, {accepted_id: 200, rejected_id: 403})
        inference = [event for event in events if event["event"] == "jev.completed"]
        self.assertEqual([event["request_id"] for event in inference], [accepted_id])
        started = [event for event in events if event["event"] == "jev.started"]
        self.assertEqual(
            [(event["request_id"], event["question"]) for event in started],
            [(accepted_id, question)],
        )
        self.assertTrue(all("\n" not in record.getMessage() for record in captured.records))
        log_text = "\n".join(captured.output)
        for sensitive in ["single-use-token", "private-test-key", "private-test-secret"]:
            self.assertNotIn(sensitive, log_text)

    def test_public_health_is_readable_without_granting_inference_access(self):
        origin = "https://untrusted.example"
        response = self.client.get("/health", headers={"Origin": origin})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok"})
        self.assertEqual(response.headers["access-control-allow-origin"], "*")
        self.assertEqual(response.headers["cache-control"], "no-store")

        preflight = self.client.options("/ask", headers={
            "Origin": origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        })
        self.assertEqual(preflight.status_code, 400)
        self.assertNotIn("access-control-allow-origin", preflight.headers)
        denied = self.client.post("/ask", headers={"Origin": origin}, json={
            "question": "Can this bypass verification?", "turnstile_token": "x",
        })
        self.assertEqual(denied.status_code, 403)
        self.assertNotIn("access-control-allow-origin", denied.headers)
        self.assertEqual(self.calls, [])

    def test_local_token_cannot_authorize_a_production_origin_request(self):
        self.verification = {"success": True, "hostname": "localhost", "action": "ask"}
        self.assertEqual(self.ask().status_code, 403)
        self.assertEqual([call.url.host for call in self.calls], ["challenges.cloudflare.com"])

    def test_untrusted_origins_never_reach_paid_service(self):
        for origin in [None, "https://attacker.example", ORIGIN + ".attacker.example",
                       "http://localhost:4173", "http://127.0.0.1:4173",
                       "http://localhost:4174", "http://localhost.attacker.example:4173"]:
            with self.subTest(origin=origin):
                response = self.client.post("/ask", headers={"Origin": origin} if origin else {}, json={"question": "Hi?", "turnstile_token": "x"})
                self.assertEqual(response.status_code, 403)
        self.assertEqual(self.calls, [])

    def test_failed_wrong_hostname_and_wrong_action_are_rejected(self):
        for verification in [
            {"success": False, "hostname": HOSTNAME, "action": "ask"},
            {"success": True, "hostname": "attacker.example", "action": "ask"},
            {"success": True, "hostname": HOSTNAME, "action": "other"},
        ]:
            with self.subTest(verification=verification):
                self.verification = verification
                self.calls.clear()
                response = self.ask()
                self.assertEqual(response.status_code, 403)
                self.assertEqual([call.url.host for call in self.calls], ["challenges.cloudflare.com"])

    def test_verified_question_returns_all_independent_probabilities(self):
        response = self.ask()
        self.assertEqual(response.status_code, 200)
        answers = response.json()["answers"]
        self.assertEqual([(answer["text"], answer["probability"]) for answer in answers], [(text, (index + 1) / 10) for index, (_, text) in enumerate(ANSWERS)])
        paid_calls = [call for call in self.calls if call.url.host == "api.typesafe.ai"]
        self.assertEqual(len(paid_calls), 1)
        batch = json.loads(paid_calls[0].content)
        self.assertEqual(batch["state"], {"question": "Is the sun a star?"})
        self.assertEqual(len(batch["questions"]), 9)
        self.assertEqual({q["type"] for q in batch["questions"].values()}, {"noul"})
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertNotIn("private-test", response.text)

    def test_non_binary_override_uses_strict_probability_threshold(self):
        for probability, expected_id in [
            (0.09999999999999999, "not_yes_no"),
            (0.10, ANSWERS[-1][0]),
            (0.10000000000000002, ANSWERS[-1][0]),
        ]:
            with self.subTest(yes_no_probability=probability):
                self.upstream["answers"]["is_yes_no"]["noul"] = probability
                response = self.ask(question="Tell me a story")
                self.assertEqual(response.status_code, 200)
                data = response.json()
                self.assertEqual(data["selected_answer"]["id"], expected_id)
                self.assertEqual(data["yes_no_probability"], probability)
                if expected_id == "not_yes_no":
                    self.assertEqual(data["selected_answer"]["text"], "Yes or no, babe. Work with me.")
                self.assertEqual(len(data["answers"]), 8)

    def test_invalid_or_missing_question_type_is_not_treated_as_yes_or_no(self):
        for invalid in [None, True, -0.01, 1.01, "0.99"]:
            with self.subTest(invalid=invalid):
                self.upstream["answers"]["is_yes_no"]["noul"] = invalid
                self.assertEqual(self.ask().status_code, 502)
        del self.upstream["answers"]["is_yes_no"]
        self.assertEqual(self.ask().status_code, 502)

    def test_invalid_inputs_do_not_spend_tokens_or_echo_secrets(self):
        for question in ["  ", "x" * 501, 123]:
            with self.subTest(question=question):
                response = self.ask(question=question)
                self.assertEqual(response.status_code, 422)
                self.assertNotIn("single-use-token", response.text)
        self.assertEqual(self.calls, [])
        response = self.client.post("/ask", headers={"Origin": ORIGIN, "Content-Type": "application/json"}, content=b"x" * 32769)
        self.assertEqual(response.status_code, 413)
        self.assertEqual(self.calls, [])

    def test_partial_or_invalid_probabilities_never_become_predictions(self):
        first = ANSWERS[0][0]
        for invalid in [None, True, -0.01, 1.01, "0.8"]:
            with self.subTest(invalid=invalid):
                self.upstream["answers"][first]["noul"] = invalid
                self.assertEqual(self.ask().status_code, 502)
        del self.upstream["answers"][first]
        self.assertEqual(self.ask().status_code, 502)


if __name__ == "__main__":
    unittest.main()
