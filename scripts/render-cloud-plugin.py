#!/usr/bin/env python3
"""Render public QQ Mail connection manifests without network or secret access.

Only Python's standard library is used. This is an operator packaging tool,
not part of the MCP tool surface. The output directory must not already exist.
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
from urllib.parse import urlsplit


PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"
RESERVED_LABELS = {"example", "invalid", "localhost", "local", "localdomain", "internal", "lan", "home", "test"}
PLACEHOLDER = re.compile(r"(?:example|invalid|placeholder|replace|changeme|your[-_])", re.IGNORECASE)


def validate_url(value: str) -> str:
    if not isinstance(value, str) or len(value) > 2048 or re.search(r"[\s\x00-\x1f\x7f\\]", value):
        raise ValueError("URL must be a public HTTPS /mcp endpoint without whitespace.")
    try:
        parsed = urlsplit(value)
        hostname = parsed.hostname
        port = parsed.port
    except ValueError as exc:
        raise ValueError("Invalid endpoint URL.") from exc
    if (parsed.scheme != "https" or not hostname or parsed.username is not None or parsed.password is not None
            or parsed.path != "/mcp" or parsed.query or parsed.fragment or "?" in value or "#" in value):
        raise ValueError("URL must be HTTPS with exactly /mcp and no credentials, query or fragment.")
    if port is not None and not 1 <= port <= 65535:
        raise ValueError("Invalid endpoint port.")
    if parsed.netloc != hostname + (f":{port}" if port is not None else ""):
        raise ValueError("Use a canonical lowercase hostname and optional numeric port.")
    # A DNS hostname is required; no IP literals, short names or local/reserved labels.
    try:
        ipaddress.ip_address(hostname)
    except ValueError:
        pass
    else:
        raise ValueError("A public DNS hostname is required; IP literals are not accepted.")
    labels = hostname.lower().split(".")
    if (len(hostname) > 253 or len(labels) < 2 or any(label in RESERVED_LABELS for label in labels)
            or any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in labels)
            or not re.fullmatch(r"[a-z]{2,63}", labels[-1]) or PLACEHOLDER.search(hostname)):
        raise ValueError("Use a registered public hostname, not a local or example/invalid placeholder.")
    return value


def validate_client_id(value: str) -> str:
    if (not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9._~:/+\-]{1,256}", value)
            or PLACEHOLDER.search(value)):
        raise ValueError("Use the registered public OAuth client ID, without placeholders or whitespace.")
    return value


def render(url: str, client_id: str, output: Path) -> Path:
    url = validate_url(url)
    client_id = validate_client_id(client_id)
    output = Path(output)
    if not output.is_absolute() or ".." in output.parts:
        raise ValueError("Output must be an absolute new directory without parent traversal.")
    if os.path.lexists(output):
        raise ValueError("Output already exists; refusing to overwrite any directory or file.")
    if not output.parent.is_dir():
        raise ValueError("Output parent directory must already exist.")
    plugin = {
        "$schema": PLUGIN_SCHEMA,
        "name": "qq-mail",
        "version": "0.4.0",
        "description": "Remote QQ Mail over HTTPS and OAuth, with bounded owner-authorized mail actions.",
        "keywords": ["qq-mail", "email", "imap", "smtp"],
        "extensions": {"com.openai": {"interface": {
            "displayName": "QQ 邮箱",
            "shortDescription": "通过 OAuth 连接远程邮箱服务，按用户授权范围读取和处理邮件。",
            "capabilities": ["Read", "Write"],
        }}},
    }
    mcp = {
        "$schema": MCP_SCHEMA,
        "mcpServers": {"qq-mail": {
            "type": "streamable-http",
            "url": url,
            "extensions": {"com.openai": {"auth": {
                "type": "oauth",
                "client": {"mode": "provided", "clientId": client_id, "tokenEndpointAuthMethod": "none"},
                "resource": url,
                "baseScopes": ["mail.read", "mail.drafts.read"],
            }}},
        }},
    }
    # mkdir is exclusive even if another process creates the path after validation.
    # Leave a partial new directory for review if a filesystem write fails; never
    # delete or overwrite paths as recovery. The caller must choose a fresh path.
    output.mkdir(mode=0o700, exist_ok=False)
    for name, document in (("plugin.json", plugin), ("mcp.json", mcp)):
        with (output / name).open("x", encoding="utf-8", newline="\n") as handle:
            json.dump(document, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
    return output


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True, help="Public HTTPS endpoint ending in exactly /mcp.")
    parser.add_argument("--client-id", required=True, help="Registered public OAuth client ID (never a client secret).")
    parser.add_argument("--output", required=True, type=Path, help="Absolute output directory; must not exist.")
    args = parser.parse_args()
    try:
        output = render(args.url, args.client_id, args.output)
    except (ValueError, OSError) as exc:
        parser.exit(2, f"Cannot render cloud plugin: {exc}\n")
    print(f"Created public connection manifests in {output}")
    print("No network check, deployment, plugin installation or authorization was performed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
