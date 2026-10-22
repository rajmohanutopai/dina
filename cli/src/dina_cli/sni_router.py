"""SNI router for the hosting machine (HOSTED_DINA §3.1).

Listens on port 443 and forwards each TLS connection, still encrypted, to the
place its server name points: the front door's own TLS front, or a cell's
Caddy. It reads only the server name in the ClientHello and never holds a
certificate or key, so it cannot read or change what a browser and a cell say
to each other.

To a cell it first sends a PROXY protocol v1 line naming the browser's
address, which the cell's Caddy accepts from this router alone, so the gate
behind it can count wrong passphrases per client.
"""

from __future__ import annotations

import asyncio
from typing import Callable

MAX_HELLO = 16 * 1024


def server_name(record: bytes) -> str | None:
    """The SNI host name in a TLS ClientHello record, lower-cased, or None."""
    try:
        if len(record) < 5 or record[0] != 0x16:  # handshake record
            return None
        body = record[5 : 5 + int.from_bytes(record[3:5], "big")]
        if len(body) < 4 or body[0] != 0x01:  # ClientHello
            return None
        p = 4 + 2 + 32  # header, version, random
        p += 1 + body[p]  # session id
        p += 2 + int.from_bytes(body[p : p + 2], "big")  # cipher suites
        p += 1 + body[p]  # compression methods
        end = p + 2 + int.from_bytes(body[p : p + 2], "big")
        p += 2
        while p + 4 <= end:
            kind = int.from_bytes(body[p : p + 2], "big")
            size = int.from_bytes(body[p + 2 : p + 4], "big")
            data = body[p + 4 : p + 4 + size]
            p += 4 + size
            if kind != 0x0000:  # server_name
                continue
            q = 2
            while q + 3 <= len(data):
                name_type = data[q]
                length = int.from_bytes(data[q + 1 : q + 3], "big")
                name = data[q + 3 : q + 3 + length]
                q += 3 + length
                if name_type == 0:
                    text = name.decode("ascii")
                    return text.lower() if text and all(c.isalnum() or c in ".-" for c in text) else None
        return None
    except (IndexError, UnicodeDecodeError):
        return None


async def _read_hello(reader: asyncio.StreamReader) -> bytes:
    head = await reader.readexactly(5)
    size = int.from_bytes(head[3:5], "big")
    if size > MAX_HELLO:
        raise ValueError("client hello too large")
    return head + await reader.readexactly(size)


async def _pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except (ConnectionError, asyncio.IncompleteReadError):
        pass
    finally:
        writer.close()


Target = tuple[str, int] | tuple[str, int, bool]


def proxy_line(peer: tuple, local: tuple) -> bytes:
    """A PROXY protocol v1 header for a TCP connection from `peer` to `local`."""
    family = "TCP6" if ":" in str(peer[0]) else "TCP4"
    return f"PROXY {family} {peer[0]} {local[0]} {peer[1]} {local[1]}\r\n".encode("ascii")


def make_handler(route: Callable[[str], Target | None]):
    """Forward by `route(server_name) -> (host, port[, send_proxy_line])`."""

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            hello = await asyncio.wait_for(_read_hello(reader), timeout=10)
        except (asyncio.TimeoutError, asyncio.IncompleteReadError, ValueError, ConnectionError):
            writer.close()
            return
        name = server_name(hello)
        target = route(name) if name is not None else None
        if target is None:
            writer.close()
            return
        host, port = target[0], target[1]
        try:
            up_reader, up_writer = await asyncio.open_connection(host, port)
        except OSError:
            writer.close()
            return
        if len(target) > 2 and target[2]:
            peer = writer.get_extra_info("peername")
            local = writer.get_extra_info("sockname")
            if peer is None or local is None:
                up_writer.close()
                writer.close()
                return
            up_writer.write(proxy_line(peer, local))
        up_writer.write(hello)
        await up_writer.drain()
        await asyncio.gather(_pipe(reader, up_writer), _pipe(up_reader, writer))

    return handle


def cell_route(
    front_door_host: str,
    front_door_target: tuple[str, int],
    owner_domain: str,
    cell_port: Callable[[str], int | None],
) -> Callable[[str], Target | None]:
    """Front door by its name; `<label>.<owner_domain>` to that cell's Caddy
    port, with a PROXY line so the cell sees the browser's address."""

    def route(name: str) -> Target | None:
        if name == front_door_host:
            return front_door_target
        suffix = "." + owner_domain
        if name.endswith(suffix):
            label = name[: -len(suffix)]
            port = cell_port(label) if "." not in label else None
            return ("127.0.0.1", port, True) if port is not None else None
        return None

    return route


async def serve(route: Callable[[str], Target | None], host: str, port: int) -> None:
    server = await asyncio.start_server(make_handler(route), host, port)
    async with server:
        await server.serve_forever()
