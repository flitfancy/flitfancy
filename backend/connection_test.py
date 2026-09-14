"""Exercise the real server's TCP admission without loading production config."""
import ast
import os
from pathlib import Path
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def main():
    source_path = Path(__file__).with_name("server.py")
    tree = ast.parse(source_path.read_text(encoding="utf-8"))
    server_class = next(node for node in tree.body
                        if isinstance(node, ast.ClassDef) and node.name == "FlitFancyServer")
    scope = dict(ThreadingHTTPServer=ThreadingHTTPServer, os=os, socket=socket,
                 threading=threading, REQUEST_READ_TIMEOUT=10)
    exec(compile(ast.Module(body=[server_class], type_ignores=[]), str(source_path), "exec"), scope)
    server = scope["FlitFancyServer"](("127.0.0.1", 0), BaseHTTPRequestHandler)
    clients = []
    try:
        # A page's parallel script requests can arrive before the accept loop
        # gets its next turn. Hold acceptance until this bounded burst arrives.
        for index in range(24):
            try:
                client = socket.create_connection(server.server_address, timeout=0.3)
            except OSError as exc:
                raise AssertionError(f"page-load connection {index + 1}/24 refused before acceptance") from exc
            clients.append(client)
        print("server accepts a 24-connection page-load burst")
    finally:
        for client in clients:
            client.close()
        server.server_close()


if __name__ == "__main__":
    main()
