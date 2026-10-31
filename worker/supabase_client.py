"""Minimal Supabase client for the worker (service key, never for web/).

Sends the secret key like supabase-js: the apikey header plus an
Authorization Bearer header. Errors never include the key or headers.
"""

import os

try:
    import httpx2 as httpx
except ImportError:
    import httpx

from dotenv import load_dotenv


class SupabaseError(Exception):
    pass


class SupabaseClient:
    """PostgREST + Storage access with the service key from the environment."""

    def __init__(self, url=None, key=None, timeout=30.0):
        load_dotenv()
        self.url = (url or os.environ.get("SUPABASE_URL") or "").rstrip("/")
        self.key = key or os.environ.get("SUPABASE_SECRET_KEY") or ""
        if not self.url:
            raise SupabaseError("SUPABASE_URL is not set")
        if not self.key:
            raise SupabaseError("SUPABASE_SECRET_KEY is not set")
        self._http = httpx.Client(base_url=self.url, timeout=timeout)

    def _headers(self, extra=None):
        headers = {"apikey": self.key,
                   "Authorization": "Bearer %s" % self.key}
        if extra:
            headers.update(extra)
        return headers

    def _redact(self, text):
        if self.key and self.key in text:
            return text.replace(self.key, "[redacted]")
        return text

    def _request(self, method, path, **kwargs):
        try:
            response = self._http.request(
                method, path,
                headers=self._headers(kwargs.pop("headers", None)), **kwargs)
        except httpx.HTTPError as exc:
            raise SupabaseError(
                self._redact("%s %s failed: %s" % (method, path, exc))
            ) from exc
        if response.status_code >= 400:
            raise SupabaseError(self._redact(
                "%s %s failed with status %d: %s"
                % (method, path, response.status_code,
                   (response.text or "")[:500])))
        return response

    @staticmethod
    def _decode(response):
        if not response.content:
            return None
        return response.json()

    def rpc(self, name, params=None):
        """Call a Postgres function via POST /rest/v1/rpc/<name>."""
        response = self._request("POST", "/rest/v1/rpc/%s" % name,
                                 json=params or {})
        return self._decode(response)

    def select(self, table, params=None):
        """GET rows from a table. Returns a list."""
        query = {"select": "*"}
        if params:
            query.update(params)
        response = self._request("GET", "/rest/v1/%s" % table, params=query)
        return self._decode(response) or []

    def insert(self, table, rows):
        """POST one row or a list of rows. Returns the created rows."""
        response = self._request("POST", "/rest/v1/%s" % table, json=rows,
                                 headers={"Prefer": "return=representation"})
        return self._decode(response)

    def update(self, table, values, params):
        """PATCH rows matching PostgREST filters. Returns updated rows."""
        response = self._request("PATCH", "/rest/v1/%s" % table,
                                 params=params, json=values,
                                 headers={"Prefer": "return=representation"})
        return self._decode(response)

    def upsert(self, table, rows, on_conflict=None):
        """POST with merge-duplicates. Returns the written rows."""
        params = {"on_conflict": on_conflict} if on_conflict else None
        response = self._request(
            "POST", "/rest/v1/%s" % table, params=params, json=rows,
            headers={"Prefer":
                     "resolution=merge-duplicates,return=representation"})
        return self._decode(response)

    def download(self, bucket, path):
        """Download one private Storage object. Returns bytes."""
        response = self._request(
            "GET", "/storage/v1/object/%s/%s" % (bucket, path))
        return response.content
