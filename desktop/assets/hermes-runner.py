"""PE Studio's text-only bridge for the installed Hermes 0.11.x runtime.

No CLI/Agent loop is created. Probe reads package source metadata only; model
generation reuses the native credential resolver and makes one text request.
No user settings, credentials, prompt, or raw exception is emitted to logs.
"""
import ast
import contextlib
import importlib.abc
import importlib.util
import json
import logging
import os
from pathlib import Path
import re
import sys


_PHASES = {"setup", "routing", "request", "response"}
_CURRENT_PHASE = "setup"
_ERROR_CODES = {"unsupported", "provider", "model", "credentials", "input", "response", "restricted",
                "timeout", "network", "authentication", "permission", "billing", "rate_limit",
                "invalid_request", "not_found", "unavailable", "runtime"}


class BridgeError(Exception):
    def __init__(self, code):
        self.code = code
        self.phase = _CURRENT_PHASE


def safe_error_result(error):
    """Classify structured exception metadata without emitting its text/body/URL.

    SDKs wrap httpx errors in APIConnectionError; inspect a bounded cause chain
    so a wrapped timeout remains distinguishable from a rejected credential.
    HTTP 400/404 do not prove a bad model: either can be an endpoint error.
    """
    phase = getattr(error, "phase", _CURRENT_PHASE)
    if phase not in _PHASES:
        phase = "setup"
    code = "runtime"
    if isinstance(error, BridgeError):
        code = error.code if error.code in _ERROR_CODES else "runtime"
    else:
        chain, current = [], error
        for _ in range(5):
            if current is None or any(current is item for item in chain):
                break
            chain.append(current)
            current = getattr(current, "__cause__", None) or getattr(current, "__context__", None)
        statuses = [getattr(item, "status_code", None) for item in chain]
        status = next((value for value in statuses if isinstance(value, int) and not isinstance(value, bool)), None)
        status_codes = {400: "invalid_request", 401: "authentication", 402: "billing", 403: "permission",
                        404: "not_found", 408: "timeout", 429: "rate_limit"}
        names = {cls.__name__ for item in chain for cls in type(item).__mro__}
        if status in status_codes:
            code = status_codes[status]
        elif status is not None and 500 <= status <= 599:
            code = "unavailable"
        elif names.intersection({"TimeoutError", "TimeoutException", "APITimeoutError"}):
            code = "timeout"
        elif names.intersection({"APIConnectionError", "NetworkError", "ConnectError", "ProxyError",
                                  "ConnectionError", "ConnectionRefusedError", "ConnectionResetError",
                                  "RemoteProtocolError", "gaierror"}):
            code = "network"
    return {"type": "pe-hermes-result", "ok": False, "code": code, "phase": phase}


def source_tree():
    spec = importlib.util.find_spec("hermes_cli")
    if not spec or not spec.origin:
        raise BridgeError("unsupported")
    root = Path(spec.origin).parent.parent
    init = ast.parse(Path(spec.origin).read_text(encoding="utf-8"))
    version = next((node.value.value for node in init.body
                    if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant)
                    and any(isinstance(t, ast.Name) and t.id == "__version__" for t in node.targets)), "")
    if not isinstance(version, str) or not re.fullmatch(r"0\.11\.\d+", version):
        raise BridgeError("unsupported")
    required = {
        "hermes_cli/runtime_provider.py": {"resolve_runtime_provider", "resolve_requested_provider"},
        "hermes_cli/config.py": {"load_config"},
        "agent/auxiliary_client.py": {"CodexAuxiliaryClient", "_codex_cloudflare_headers"},
        "agent/anthropic_adapter.py": {"build_anthropic_client", "build_anthropic_kwargs"},
    }
    for name, symbols in required.items():
        tree = ast.parse((root / name).read_text(encoding="utf-8"))
        found = {node.name for node in tree.body if isinstance(node, (ast.ClassDef, ast.FunctionDef))}
        if not symbols.issubset(found):
            raise BridgeError("unsupported")
    return version


class NoAgentImports(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.split(".")[0] in {"cli", "run_agent", "model_tools", "tools", "plugins", "gateway", "cron"} \
                or fullname in {"hermes_cli.main", "hermes_cli.plugins", "agent.memory_manager", "agent.shell_hooks"}:
            raise BridgeError("restricted")
        return None


def block_local_commands(event, args):
    if event in {"subprocess.Popen", "os.system", "os.exec", "os.posix_spawn", "os.posix_spawnp"}:
        raise BridgeError("restricted")


def active_profile():
    # Mirror Hermes' sticky active profile without importing its CLI bootstrap.
    # An explicit profile/home selected for this invocation always wins.
    if os.environ.get("HERMES_HOME", "").strip():
        return
    from hermes_constants import get_default_hermes_root
    root = get_default_hermes_root()
    marker = root / "active_profile"
    if marker.is_file():
        name = marker.read_text(encoding="utf-8").strip()
        if name and name != "default":
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", name):
                raise BridgeError("credentials")
            profile = root / "profiles" / name
            if not profile.is_dir():
                raise BridgeError("credentials")
            os.environ["HERMES_HOME"] = str(profile)


def generate(prompt, selected_model):
    global _CURRENT_PHASE
    _CURRENT_PHASE = "setup"
    source_tree()
    sys.meta_path.insert(0, NoAgentImports())
    sys.addaudithook(block_local_commands)
    logging.disable(logging.CRITICAL)
    active_profile()
    from hermes_constants import get_hermes_home
    # python-dotenv parses values; unlike the CLI's env loader it does not
    # sanitize/rewrite the user's .env file or load any project fallback.
    from dotenv import load_dotenv
    load_dotenv(get_hermes_home() / ".env", override=True)
    # Match Hermes' native proxy handling before either credential refresh or
    # model requests; normalize only process memory, never the user's .env.
    from utils import normalize_proxy_env_vars
    normalize_proxy_env_vars()
    import hermes_cli.config as config_module
    # Loading routing data must not bootstrap SOUL.md/directories or memory.
    config_module.ensure_hermes_home = lambda: None
    _CURRENT_PHASE = "routing"
    config = config_module.load_config()
    model_config = config.get("model", {})
    if isinstance(model_config, str):
        model_config = {"default": model_config}
    if not isinstance(model_config, dict):
        raise BridgeError("model")
    model = selected_model if selected_model != "default" else model_config.get("default") or model_config.get("model")
    model = model.strip() if isinstance(model, str) else ""
    from hermes_cli.runtime_provider import resolve_requested_provider, resolve_runtime_provider
    from hermes_cli.auth import PROVIDER_REGISTRY, resolve_provider
    requested = resolve_requested_provider()
    # Named custom routes need their resolver; registry routes are checked
    # before credential resolution to exclude subprocess/SDK agent backends.
    if requested.startswith("custom:") or requested not in PROVIDER_REGISTRY and requested not in {"auto", "custom", "openrouter"}:
        provider = requested
    else:
        provider = resolve_provider(requested)
    entry = PROVIDER_REGISTRY.get(provider)
    if entry and entry.auth_type in {"external_process", "aws_sdk"}:
        raise BridgeError("provider")
    if provider == "google-gemini-cli":
        raise BridgeError("provider")
    runtime = resolve_runtime_provider(requested=requested, target_model=model or None)
    mode = runtime.get("api_mode", "chat_completions")
    base = runtime.get("base_url", "")
    key = runtime.get("api_key", "")
    if mode not in {"chat_completions", "codex_responses", "anthropic_messages"} or not isinstance(base, str) or not base.startswith(("https://", "http://")):
        raise BridgeError("provider")
    if not isinstance(key, str) or not key:
        raise BridgeError("credentials")
    # Runtime's native custom route can carry its own model default.
    if selected_model == "default" and isinstance(runtime.get("model"), str) and runtime["model"].strip():
        model = runtime["model"].strip()
    if not model:
        raise BridgeError("model")
    messages = [{"role": "system", "content": "You optimize prompts. Return only the requested prompt output. Do not call tools."},
                {"role": "user", "content": prompt}]
    client = None
    try:
        _CURRENT_PHASE = "request"
        if mode == "anthropic_messages":
            from agent.anthropic_adapter import build_anthropic_client, build_anthropic_kwargs, _is_oauth_token
            client = build_anthropic_client(key, base, timeout=150)
            if callable(getattr(client, "with_options", None)):
                client = client.with_options(max_retries=0)
            kwargs = build_anthropic_kwargs(model=model, messages=messages, tools=None, max_tokens=8192,
                                           reasoning_config=None, is_oauth=_is_oauth_token(key), base_url=base)
            kwargs.pop("tools", None)
            kwargs.pop("tool_choice", None)
            response = client.messages.create(**kwargs)
            _CURRENT_PHASE = "response"
            if getattr(response, "stop_reason", None) != "end_turn":
                raise BridgeError("response")
            blocks = response.content
            if any(getattr(block, "type", None) == "tool_use" for block in blocks):
                raise BridgeError("restricted")
            text = "".join(block.text for block in blocks if getattr(block, "type", None) == "text")
        else:
            from openai import OpenAI
            from agent.auxiliary_client import CodexAuxiliaryClient, _codex_cloudflare_headers
            headers = _codex_cloudflare_headers(key) if runtime.get("provider") == "openai-codex" else {}
            from urllib.parse import urlparse
            hostname = (urlparse(base).hostname or "").lower()
            if hostname == "api.githubcopilot.com":
                from hermes_cli.models import copilot_default_headers
                headers.update(copilot_default_headers())
            elif hostname == "api.kimi.com":
                headers["User-Agent"] = "claude-code/0.1.0"
            client = OpenAI(api_key=key, base_url=base, default_headers=headers, timeout=150, max_retries=0)
            call_client = CodexAuxiliaryClient(client, model) if mode == "codex_responses" else client
            if runtime.get("provider") == "gemini" and mode == "chat_completions":
                from agent.gemini_native_adapter import GeminiNativeClient, is_native_gemini_base_url
                if is_native_gemini_base_url(base):
                    client.close()
                    client = GeminiNativeClient(api_key=key, base_url=base)
                    call_client = client
            response = call_client.chat.completions.create(model=model, messages=messages)
            _CURRENT_PHASE = "response"
            choice = response.choices[0] if getattr(response, "choices", None) else None
            if not choice or getattr(choice, "finish_reason", None) != "stop":
                raise BridgeError("response")
            if getattr(choice.message, "tool_calls", None) or getattr(choice.message, "function_call", None):
                raise BridgeError("restricted")
            text = choice.message.content
        if not isinstance(text, str) or not text.strip() or len(text.encode("utf-8")) > 900000:
            raise BridgeError("response")
        secrets = [key] + [value for name, value in os.environ.items() if name.endswith(("_KEY", "_TOKEN", "_SECRET", "_PASSWORD")) and len(value) >= 8]
        if any(secret and secret in text for secret in secrets):
            raise BridgeError("restricted")
        return {"type": "pe-hermes-result", "ok": True, "textOnly": True, "text": text}
    finally:
        if client is not None and callable(getattr(client, "close", None)):
            client.close()


def main():
    result = safe_error_result(RuntimeError())
    with open(os.devnull, "w") as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        try:
            if sys.argv[1:] == ["--probe"]:
                result = {"type": "pe-hermes-probe", "available": True, "version": source_tree(), "textOnly": True}
            elif len(sys.argv) == 3 and sys.argv[1] == "--model":
                model = sys.argv[2]
                if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._:/+\-]{0,199}", model):
                    raise BridgeError("model")
                prompt = sys.stdin.buffer.read(262145)
                if not prompt or len(prompt) > 262144:
                    raise BridgeError("input")
                result = generate(prompt.decode("utf-8"), model)
            else:
                raise BridgeError("input")
        except Exception as error:
            result = safe_error_result(error)
    # Errors also exit 0 so the runner can present the safe, classified code;
    # neither stderr nor raw provider exception text crosses into the renderer.
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
