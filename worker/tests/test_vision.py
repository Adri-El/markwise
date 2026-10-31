"""Offline tests for worker.vision. Rendering and the API are mocked."""

import base64
import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from worker.vision import (
    TRANSCRIBE_PROMPT,
    pages_needing_vision,
    transcribe_page,
    transcribe_script,
)


class FakeResponses:
    def __init__(self, text="line one", usage=None):
        self.text = text
        self.usage = usage or {"input_tokens": 11, "output_tokens": 7}
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(
            output=[{"type": "message",
                     "content": [{"text": self.text}]}],
            usage=dict(self.usage))


class FakeClient:
    def __init__(self, text="line one", usage=None):
        self.responses = FakeResponses(text, usage)


class PagesNeedingVisionTests(unittest.TestCase):
    def test_threshold_is_20_non_space_chars(self):
        pages = ["x" * 19, "y" * 20, "a b c", "", None, "word " * 10]
        self.assertEqual(pages_needing_vision(pages), [1, 3, 4, 5])

    def test_whitespace_does_not_count(self):
        self.assertEqual(pages_needing_vision(["  a  b  "]), [1])
        self.assertEqual(pages_needing_vision(["x" * 20 + " " * 50]), [])


class TranscribePageTests(unittest.TestCase):
    def test_request_shape(self):
        client = FakeClient("Q1 hello")
        result = transcribe_page(b"IMG", client=client, model="m")
        self.assertEqual(result["text"], "Q1 hello")
        self.assertEqual(result["usage"],
                         {"input_tokens": 11, "output_tokens": 7})
        self.assertEqual(len(client.responses.calls), 1)
        call = client.responses.calls[0]
        self.assertEqual(call["model"], "m")
        self.assertEqual(call["temperature"], 0)
        self.assertEqual(call["tools"], [])
        [message] = call["input"]
        self.assertEqual(message["role"], "user")
        kinds = [part["type"] for part in message["content"]]
        self.assertEqual(kinds, ["input_text", "input_image"])
        self.assertEqual(message["content"][0]["text"], TRANSCRIBE_PROMPT)
        self.assertEqual(
            message["content"][1]["image_url"],
            "data:image/jpeg;base64,"
            + base64.b64encode(b"IMG").decode("ascii"))

    def test_model_from_env_with_default(self):
        with patch.dict(os.environ, {"VISION_MODEL": "vis-model"}):
            client = FakeClient()
            transcribe_page(b"x", client=client)
            self.assertEqual(client.responses.calls[0]["model"],
                             "vis-model")
        with patch.dict(os.environ, {"VISION_MODEL": ""}), \
                patch("worker.vision._model_from_env",
                      return_value="base-model"):
            client = FakeClient()
            transcribe_page(b"x", client=client)
            self.assertEqual(client.responses.calls[0]["model"],
                             "base-model")

    def test_client_from_env_when_missing(self):
        client = FakeClient()
        with patch("worker.vision._client_from_env",
                   return_value=client):
            transcribe_page(b"x", model="m")
        self.assertEqual(len(client.responses.calls), 1)


class TranscribeScriptTests(unittest.TestCase):
    LONG = "Q1 " + "word " * 10

    def test_sends_only_empty_pages(self):
        pages = [self.LONG, ""]
        with patch("worker.vision.render_page_jpeg",
                   return_value=b"JPEG") as render, \
                patch("worker.vision.transcribe_page",
                      return_value={"text": "Q2 hello world",
                                    "usage": {"input_tokens": 1,
                                              "output_tokens": 2}}) as tr:
            result = transcribe_script("x.pdf", pages,
                                       client=FakeClient(), model="m")
        render.assert_called_once_with("x.pdf", 2)
        tr.assert_called_once()
        args, kwargs = tr.call_args
        self.assertEqual(args, (b"JPEG",))
        self.assertEqual(kwargs["model"], "m")
        self.assertEqual(result["pages"], [self.LONG, "Q2 hello world"])
        self.assertEqual([t["source"] for t in result["transcript"]],
                         ["text", "vision"])
        self.assertEqual(result["transcript"][0]["text"], self.LONG)
        self.assertEqual(result["usage"],
                         {"input_tokens": 1, "output_tokens": 2})

    def test_no_vision_needed_skips_client(self):
        with patch("worker.vision.render_page_jpeg") as render, \
                patch("worker.vision._client_from_env",
                      side_effect=AssertionError("no client needed")):
            result = transcribe_script("x.pdf", [self.LONG])
        render.assert_not_called()
        self.assertEqual(result["pages"], [self.LONG])
        self.assertEqual(result["transcript"],
                         [{"page": 1, "source": "text", "text": self.LONG}])
        self.assertEqual(result["usage"],
                         {"input_tokens": 0, "output_tokens": 0})

    def test_max_pages_caps_vision(self):
        with patch("worker.vision.render_page_jpeg",
                   return_value=b"JPEG") as render, \
                patch("worker.vision.transcribe_page",
                      return_value={"text": "done",
                                    "usage": {"input_tokens": 1,
                                              "output_tokens": 1}}):
            result = transcribe_script("x.pdf", ["", ""], client=FakeClient(),
                                       model="m", max_pages=1)
        render.assert_called_once_with("x.pdf", 1)
        self.assertEqual([t["source"] for t in result["transcript"]],
                         ["vision", "failed"])
        self.assertEqual(result["transcript"][1]["text"], "")
        self.assertIn("limit", result["transcript"][1]["note"])

    def test_api_exception_becomes_failed(self):
        with patch("worker.vision.render_page_jpeg",
                   return_value=b"JPEG"), \
                patch("worker.vision.transcribe_page",
                      side_effect=RuntimeError("image input rejected")):
            result = transcribe_script("x.pdf", [""], client=FakeClient(),
                                       model="m")
        self.assertEqual(result["pages"], [""])
        self.assertEqual(result["transcript"][0]["source"], "failed")
        self.assertIn("image input rejected",
                      result["transcript"][0]["note"])
        self.assertEqual(result["usage"],
                         {"input_tokens": 0, "output_tokens": 0})

    def test_render_exception_becomes_failed(self):
        with patch("worker.vision.render_page_jpeg",
                   side_effect=ValueError("bad pdf")), \
                patch("worker.vision.transcribe_page") as tr:
            result = transcribe_script("x.pdf", [""], client=FakeClient(),
                                       model="m")
        tr.assert_not_called()
        self.assertEqual(result["transcript"][0]["source"], "failed")
        self.assertIn("bad pdf", result["transcript"][0]["note"])

    def test_client_failure_fails_needy_pages(self):
        pages = [self.LONG, ""]
        with patch("worker.vision._client_from_env",
                   side_effect=RuntimeError("no key")), \
                patch("worker.vision.render_page_jpeg") as render:
            result = transcribe_script("x.pdf", pages)
        render.assert_not_called()
        self.assertEqual([t["source"] for t in result["transcript"]],
                         ["text", "failed"])
        self.assertEqual(result["transcript"][0]["text"], self.LONG)
        self.assertIn("no key", result["transcript"][1]["note"])


if __name__ == "__main__":
    unittest.main()
