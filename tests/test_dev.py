import unittest

from fastapi.testclient import TestClient

from dev import create_dev_api


class DevelopmentBoundaryTests(unittest.TestCase):
    def setUp(self):
        # Boundary rejection must happen before lifespan state or authenticated RPC is used.
        self.client = TestClient(create_dev_api(), base_url="http://localhost:4173")
        self.addCleanup(self.client.close)

    def test_foreign_and_missing_origins_cannot_spend_development_tokens(self):
        for origin in [None, "https://attacker.example", "http://localhost:4174"]:
            with self.subTest(origin=origin):
                response = self.client.post(
                    "/api/ask", headers={"Origin": origin} if origin else {},
                    json={"question": "Is this allowed?", "turnstile_token": "XXXX.DUMMY.TOKEN.XXXX"},
                )
                self.assertEqual(response.status_code, 403)

    def test_rebound_host_cannot_access_authenticated_development_server(self):
        response = self.client.post(
            "/api/ask", headers={"Host": "attacker.example:4173", "Origin": "http://attacker.example:4173"},
            json={"question": "Is this allowed?", "turnstile_token": "XXXX.DUMMY.TOKEN.XXXX"},
        )
        self.assertEqual(response.status_code, 400)


if __name__ == "__main__":
    unittest.main()
