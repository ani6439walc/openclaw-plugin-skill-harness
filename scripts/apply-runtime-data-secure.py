#!/usr/bin/env python3

import argparse
import ctypes
import hashlib
import json
import os
import secrets
import stat
import sys


O_DIRECTORY = getattr(os, "O_DIRECTORY", 0)
O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
O_CLOEXEC = getattr(os, "O_CLOEXEC", 0)
READ_DIRECTORY_FLAGS = os.O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
READ_FILE_FLAGS = os.O_RDONLY | O_NOFOLLOW | O_CLOEXEC
WRITE_FILE_FLAGS = os.O_RDWR | os.O_CREAT | os.O_EXCL | O_NOFOLLOW | O_CLOEXEC
RENAME_NOREPLACE = 1
RENAME_EXCHANGE = 2
LIBC = ctypes.CDLL(None, use_errno=True)
RENAMEAT2 = LIBC.renameat2
RENAMEAT2.argtypes = (
    ctypes.c_int,
    ctypes.c_char_p,
    ctypes.c_int,
    ctypes.c_char_p,
    ctypes.c_uint,
)
RENAMEAT2.restype = ctypes.c_int


def fail(message: str) -> None:
    raise RuntimeError(message)


def parse_owned_path(value: str) -> list[str]:
    if (
        not isinstance(value, str)
        or not value
        or value.startswith("/")
        or "\\" in value
        or not value.endswith(".md")
    ):
        fail("invalid owned path")
    segments = value.split("/")
    if (
        segments[0] not in {"intents", "experiences"}
        or any(not segment or segment in {".", ".."} for segment in segments)
    ):
        fail("invalid owned path")
    return segments


def sha256_fd(fd: int) -> str:
    digest = hashlib.sha256()
    os.lseek(fd, 0, os.SEEK_SET)
    while True:
        chunk = os.read(fd, 1024 * 1024)
        if not chunk:
            break
        digest.update(chunk)
    os.lseek(fd, 0, os.SEEK_SET)
    return digest.hexdigest()


def copy_fd(source_fd: int, temporary_fd: int) -> None:
    os.lseek(source_fd, 0, os.SEEK_SET)
    while True:
        chunk = os.read(source_fd, 1024 * 1024)
        if not chunk:
            break
        view = memoryview(chunk)
        while view:
            written = os.write(temporary_fd, view)
            view = view[written:]
    os.fsync(temporary_fd)


def ensure_directory(fd: int, label: str) -> None:
    if not stat.S_ISDIR(os.fstat(fd).st_mode):
        fail(f"{label} is not a directory")


def open_existing_parent(root_fd: int, segments: list[str]) -> int:
    current = os.dup(root_fd)
    try:
        for segment in segments[:-1]:
            child = os.open(segment, READ_DIRECTORY_FLAGS, dir_fd=current)
            os.close(current)
            current = child
        return current
    except Exception:
        os.close(current)
        raise


def assert_directory_continuity(
    active_root_path: str,
    active_root_fd: int,
    directory_segments: list[str],
    directory_fd: int,
) -> None:
    assert_root_continuity(active_root_path, active_root_fd)
    visible_fd = os.dup(active_root_fd)
    try:
        for segment in directory_segments:
            child_fd = os.open(segment, READ_DIRECTORY_FLAGS, dir_fd=visible_fd)
            os.close(visible_fd)
            visible_fd = child_fd
        if not same_identity(directory_fd, visible_fd):
            fail("active ancestor changed")
    except OSError:
        fail("active ancestor changed")
    finally:
        os.close(visible_fd)


def mkdir_checked(
    active_root_path: str,
    active_root_fd: int,
    directory_segments: list[str],
    parent_fd: int,
    name: str,
) -> None:
    assert_directory_continuity(
        active_root_path, active_root_fd, directory_segments, parent_fd
    )
    os.mkdir(name, dir_fd=parent_fd)
    try:
        assert_directory_continuity(
            active_root_path, active_root_fd, directory_segments, parent_fd
        )
    except Exception:
        try:
            os.rmdir(name, dir_fd=parent_fd)
        except OSError:
            pass
        raise


def open_parent(
    active_root_path: str,
    root_fd: int,
    segments: list[str],
    create: bool,
) -> int:
    current = os.dup(root_fd)
    try:
        for index, segment in enumerate(segments[:-1]):
            try:
                child = os.open(segment, READ_DIRECTORY_FLAGS, dir_fd=current)
            except FileNotFoundError:
                if not create:
                    raise
                mkdir_checked(
                    active_root_path, root_fd, segments[:index], current, segment
                )
                child = os.open(segment, READ_DIRECTORY_FLAGS, dir_fd=current)
            os.close(current)
            current = child
        return current
    except Exception:
        os.close(current)
        raise


def open_regular(parent_fd: int, name: str) -> int | None:
    try:
        fd = os.open(name, READ_FILE_FLAGS, dir_fd=parent_fd)
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        fail("target is not a regular file")
    return fd


def same_identity(left_fd: int, right_fd: int) -> bool:
    left = os.fstat(left_fd)
    right = os.fstat(right_fd)
    return left.st_dev == right.st_dev and left.st_ino == right.st_ino


def fd_identity(fd: int) -> tuple[int, int]:
    value = os.fstat(fd)
    return value.st_dev, value.st_ino


def renameat2(
    old_parent_fd: int,
    old_name: str,
    new_parent_fd: int,
    new_name: str,
    flags: int,
) -> None:
    if RENAMEAT2(
        old_parent_fd,
        os.fsencode(old_name),
        new_parent_fd,
        os.fsencode(new_name),
        flags,
    ) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def restore_delete_exchange(parent_fd: int, name: str, temporary: str) -> None:
    renameat2(parent_fd, name, parent_fd, temporary, RENAME_EXCHANGE)


def restore_replace_exchange(parent_fd: int, name: str, temporary: str) -> None:
    renameat2(parent_fd, temporary, parent_fd, name, RENAME_EXCHANGE)


def discard_temporary(parent_fd: int, temporary: str) -> None:
    try:
        os.unlink(temporary, dir_fd=parent_fd)
    except FileNotFoundError:
        pass


def restore_delete_exchange_checked(
    active_root_path: str,
    active_root_fd: int,
    destination_segments: list[str],
    parent_fd: int,
    name: str,
    temporary: str,
) -> None:
    try:
        assert_parent_continuity(
            active_root_path, active_root_fd, destination_segments, parent_fd
        )
    except Exception:
        restore_delete_exchange(parent_fd, name, temporary)
        discard_temporary(parent_fd, temporary)
        raise
    restore_delete_exchange(parent_fd, name, temporary)
    try:
        assert_parent_continuity(
            active_root_path, active_root_fd, destination_segments, parent_fd
        )
    except Exception:
        discard_temporary(parent_fd, temporary)
        raise
    assert_parent_continuity(
        active_root_path, active_root_fd, destination_segments, parent_fd
    )
    discard_temporary(parent_fd, temporary)
    assert_parent_continuity(
        active_root_path, active_root_fd, destination_segments, parent_fd
    )


def make_temporary(
    active_root_path: str,
    active_root_fd: int,
    destination_segments: list[str],
    parent_fd: int,
    name: str,
) -> tuple[str, int]:
    for _ in range(32):
        temporary = f".{name}.{os.getpid()}.{secrets.token_hex(12)}.tmp"
        try:
            assert_parent_continuity(
                active_root_path, active_root_fd, destination_segments, parent_fd
            )
            temporary_fd = os.open(
                temporary, WRITE_FILE_FLAGS, 0o600, dir_fd=parent_fd
            )
            try:
                assert_parent_continuity(
                    active_root_path, active_root_fd, destination_segments, parent_fd
                )
            except Exception:
                os.close(temporary_fd)
                try:
                    os.unlink(temporary, dir_fd=parent_fd)
                except OSError:
                    pass
                raise
            return temporary, temporary_fd
        except FileExistsError:
            continue
    fail("unable to create unique temporary file")


def copy_temporary_checked(
    active_root_path: str,
    active_root_fd: int,
    destination_segments: list[str],
    parent_fd: int,
    temporary: str,
    source_fd: int,
    temporary_fd: int,
) -> None:
    try:
        assert_parent_continuity(
            active_root_path, active_root_fd, destination_segments, parent_fd
        )
        copy_fd(source_fd, temporary_fd)
        assert_parent_continuity(
            active_root_path, active_root_fd, destination_segments, parent_fd
        )
    except Exception:
        os.close(temporary_fd)
        try:
            os.unlink(temporary, dir_fd=parent_fd)
        except OSError:
            pass
        raise


def matches_path(path: str, fd: int) -> bool:
    try:
        path_stat = os.stat(path, follow_symlinks=False)
    except OSError:
        return False
    fd_stat = os.fstat(fd)
    return path_stat.st_dev == fd_stat.st_dev and path_stat.st_ino == fd_stat.st_ino


def assert_root_continuity(path: str, root_fd: int) -> None:
    if not matches_path(path, root_fd):
        fail("active root changed")


def assert_parent_continuity(
    active_root_path: str,
    active_root_fd: int,
    destination_segments: list[str],
    parent_fd: int,
) -> None:
    assert_root_continuity(active_root_path, active_root_fd)
    visible_parent_fd = None
    try:
        visible_parent_fd = open_existing_parent(active_root_fd, destination_segments)
        if not same_identity(parent_fd, visible_parent_fd):
            fail("active ancestor changed")
    except OSError:
        fail("active ancestor changed")
    finally:
        if visible_parent_fd is not None:
            os.close(visible_parent_fd)


def scan_directory(root_fd: int, relative_root: str, output: dict[str, str]) -> None:
    directory_fd = os.dup(root_fd)
    try:
        def visit(current_fd: int, relative: str) -> None:
            for name in os.listdir(current_fd):
                entry_relative = f"{relative}/{name}"
                entry_stat = os.stat(name, dir_fd=current_fd, follow_symlinks=False)
                if stat.S_ISLNK(entry_stat.st_mode):
                    fail(f"{entry_relative}: symbolic links are not allowed")
                if stat.S_ISDIR(entry_stat.st_mode):
                    child_fd = os.open(name, READ_DIRECTORY_FLAGS, dir_fd=current_fd)
                    try:
                        visit(child_fd, entry_relative)
                    finally:
                        os.close(child_fd)
                elif stat.S_ISREG(entry_stat.st_mode):
                    if not name.endswith(".md"):
                        fail(f"{entry_relative}: only Markdown files are allowed")
                    file_fd = open_regular(current_fd, name)
                    try:
                        if file_fd is None:
                            fail(f"{entry_relative}: entry disappeared during scan")
                        output[entry_relative] = sha256_fd(file_fd)
                    finally:
                        if file_fd is not None:
                            os.close(file_fd)
                else:
                    fail(f"{entry_relative}: special files are not allowed")

        visit(directory_fd, relative_root)
    finally:
        os.close(directory_fd)


def scan_active_preimages(
    active_root_fd: int,
) -> tuple[dict[str, str], dict[str, tuple[int, int] | None]]:
    result: dict[str, str] = {}
    owned_fds: dict[str, int] = {}
    try:
        for root_name in ("intents", "experiences"):
            try:
                owned_fds[root_name] = os.open(
                    root_name, READ_DIRECTORY_FLAGS, dir_fd=active_root_fd
                )
            except FileNotFoundError:
                continue
        for root_name, owned_fd in owned_fds.items():
            scan_directory(owned_fd, root_name, result)
        identities = {
            root_name: fd_identity(owned_fds[root_name])
            if root_name in owned_fds
            else None
            for root_name in ("intents", "experiences")
        }
        for root_name, owned_fd in owned_fds.items():
            visible_fd = None
            try:
                visible_fd = os.open(
                    root_name, READ_DIRECTORY_FLAGS, dir_fd=active_root_fd
                )
                if not same_identity(owned_fd, visible_fd):
                    fail("active owned root changed")
            except OSError:
                fail("active owned root changed")
            finally:
                if visible_fd is not None:
                    os.close(visible_fd)
    finally:
        for owned_fd in owned_fds.values():
            os.close(owned_fd)
    return result, identities


def assert_owned_roots_continuity(
    active_root_fd: int, identities: dict[str, tuple[int, int] | None]
) -> None:
    for root_name, expected in identities.items():
        visible_fd = None
        try:
            visible_fd = os.open(
                root_name, READ_DIRECTORY_FLAGS, dir_fd=active_root_fd
            )
            if expected is None or fd_identity(visible_fd) != expected:
                fail("active owned root changed")
        except FileNotFoundError:
            if expected is not None:
                fail("active owned root changed")
        except OSError:
            fail("active owned root changed")
        finally:
            if visible_fd is not None:
                os.close(visible_fd)


def parse_manifest() -> tuple[dict[str, str], list[dict]]:
    try:
        parsed = json.load(sys.stdin)
        preimages = parsed["activePreimages"]
        operations = parsed["operations"]
    except Exception:
        fail("operations manifest is invalid")
    if not isinstance(preimages, list) or not isinstance(operations, list):
        fail("operations manifest is invalid")
    expected: dict[str, str] = {}
    for item in preimages:
        if (
            not isinstance(item, dict)
            or set(item) != {"path", "sha256"}
            or not isinstance(item["sha256"], str)
            or len(item["sha256"]) != 64
        ):
            fail("operations manifest is invalid")
        parse_owned_path(item["path"])
        if item["path"] in expected:
            fail("operations manifest is invalid")
        expected[item["path"]] = item["sha256"]
    return expected, operations


def apply_to_expected_postimage(expected: dict[str, str], item: dict) -> None:
    operation = item.get("operation")
    destination = item.get("destination")
    if operation not in {"create", "replace", "delete"}:
        fail("operations manifest is invalid")
    parse_owned_path(destination)
    if operation == "delete":
        if destination not in expected:
            fail("operations manifest is invalid")
        del expected[destination]
        return
    source_hash = item.get("sha256")
    if not isinstance(source_hash, str) or len(source_hash) != 64:
        fail("operations manifest is invalid")
    expected[destination] = source_hash


def execute_operation(
    active_root_path: str,
    active_root_fd: int,
    artifact_root_fd: int,
    item: dict,
) -> None:
    operation = item.get("operation")
    destination = item.get("destination")
    if operation not in {"create", "replace", "delete"}:
        fail("operations manifest is invalid")
    destination_segments = parse_owned_path(destination)
    name = destination_segments[-1]
    parent_fd = None
    destination_fd = None
    source_fd = None
    temporary_fd = None
    try:
        parent_fd = open_parent(
            active_root_path,
            active_root_fd,
            destination_segments,
            operation == "create",
        )
        destination_fd = open_regular(parent_fd, name)
        if operation == "create":
            if destination_fd is not None:
                fail("create destination appeared")
        else:
            expected = item.get("expectedSha256")
            if (
                not isinstance(expected, str)
                or destination_fd is None
                or sha256_fd(destination_fd) != expected
            ):
                fail("active preimage changed")

        if operation == "delete":
            temporary, temporary_fd = make_temporary(
                active_root_path,
                active_root_fd,
                destination_segments,
                parent_fd,
                name,
            )
            os.close(temporary_fd)
            temporary_fd = None
            assert_parent_continuity(
                active_root_path, active_root_fd, destination_segments, parent_fd
            )
            renameat2(parent_fd, name, parent_fd, temporary, RENAME_EXCHANGE)
            swapped_fd = open_regular(parent_fd, temporary)
            try:
                if swapped_fd is None or not same_identity(destination_fd, swapped_fd):
                    restore_delete_exchange_checked(
                        active_root_path,
                        active_root_fd,
                        destination_segments,
                        parent_fd,
                        name,
                        temporary,
                    )
                    fail("active preimage changed")
                if sha256_fd(swapped_fd) != item["expectedSha256"]:
                    restore_delete_exchange_checked(
                        active_root_path,
                        active_root_fd,
                        destination_segments,
                        parent_fd,
                        name,
                        temporary,
                    )
                    fail("active preimage changed")
            finally:
                if swapped_fd is not None:
                    os.close(swapped_fd)
            try:
                assert_parent_continuity(
                    active_root_path,
                    active_root_fd,
                    destination_segments,
                    parent_fd,
                )
            except Exception:
                restore_delete_exchange(parent_fd, name, temporary)
                discard_temporary(parent_fd, temporary)
                raise
            os.unlink(temporary, dir_fd=parent_fd)
            try:
                assert_parent_continuity(
                    active_root_path,
                    active_root_fd,
                    destination_segments,
                    parent_fd,
                )
            except Exception:
                discard_temporary(parent_fd, name)
                raise
            os.unlink(name, dir_fd=parent_fd)
            assert_parent_continuity(
                active_root_path, active_root_fd, destination_segments, parent_fd
            )
            return

        source_segments = parse_owned_path(item.get("source"))
        source_parent_fd = open_existing_parent(artifact_root_fd, source_segments)
        try:
            source_fd = open_regular(source_parent_fd, source_segments[-1])
        finally:
            os.close(source_parent_fd)
        expected_source = item.get("sha256")
        if (
            source_fd is None
            or not isinstance(expected_source, str)
            or sha256_fd(source_fd) != expected_source
        ):
            fail("artifact source changed")

        temporary, temporary_fd = make_temporary(
            active_root_path,
            active_root_fd,
            destination_segments,
            parent_fd,
            name,
        )
        copy_temporary_checked(
            active_root_path,
            active_root_fd,
            destination_segments,
            parent_fd,
            temporary,
            source_fd,
            temporary_fd,
        )
        if sha256_fd(temporary_fd) != expected_source:
            os.close(temporary_fd)
            temporary_fd = None
            try:
                os.unlink(temporary, dir_fd=parent_fd)
            except OSError:
                pass
            fail("temporary file hash mismatch")
        os.close(temporary_fd)
        temporary_fd = None
        if operation == "create":
            assert_parent_continuity(
                active_root_path, active_root_fd, destination_segments, parent_fd
            )
            renameat2(parent_fd, temporary, parent_fd, name, RENAME_NOREPLACE)
            assert_parent_continuity(
                active_root_path, active_root_fd, destination_segments, parent_fd
            )
        else:
            assert_parent_continuity(
                active_root_path, active_root_fd, destination_segments, parent_fd
            )
            renameat2(parent_fd, temporary, parent_fd, name, RENAME_EXCHANGE)
            swapped_fd = open_regular(parent_fd, temporary)
            try:
                if swapped_fd is None or not same_identity(destination_fd, swapped_fd):
                    fail("active preimage changed")
                if sha256_fd(swapped_fd) != item["expectedSha256"]:
                    fail("active preimage changed")
                assert_parent_continuity(
                    active_root_path,
                    active_root_fd,
                    destination_segments,
                    parent_fd,
                )
            except Exception:
                restore_replace_exchange(parent_fd, name, temporary)
                discard_temporary(parent_fd, temporary)
                raise
            finally:
                if swapped_fd is not None:
                    os.close(swapped_fd)
            os.unlink(temporary, dir_fd=parent_fd)
            assert_parent_continuity(
                active_root_path, active_root_fd, destination_segments, parent_fd
            )
    finally:
        for fd in (temporary_fd, destination_fd, source_fd, parent_fd):
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass


def main() -> None:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--active-root-path", required=True)
    parser.add_argument("--active-root-fd", type=int, required=True)
    parser.add_argument("--artifact-root-fd", type=int, required=True)
    args = parser.parse_args()
    active_root_fd = os.dup(args.active_root_fd)
    artifact_root_fd = os.dup(args.artifact_root_fd)
    try:
        ensure_directory(active_root_fd, "active root")
        ensure_directory(artifact_root_fd, "artifact root")
        expected, operations = parse_manifest()
        preimages, _ = scan_active_preimages(active_root_fd)
        if preimages != expected:
            fail("STALE")
        expected_postimage = dict(expected)
        for item in operations:
            execute_operation(args.active_root_path, active_root_fd, artifact_root_fd, item)
            assert_root_continuity(args.active_root_path, active_root_fd)
            apply_to_expected_postimage(expected_postimage, item)
        postimage, owned_root_identities = scan_active_preimages(active_root_fd)
        if postimage != expected_postimage:
            fail("active postimage changed")
        assert_owned_roots_continuity(active_root_fd, owned_root_identities)
        assert_root_continuity(args.active_root_path, active_root_fd)
        final_postimage, final_owned_root_identities = scan_active_preimages(
            active_root_fd
        )
        if final_postimage != expected_postimage:
            fail("active postimage changed")
        assert_owned_roots_continuity(active_root_fd, final_owned_root_identities)
        assert_root_continuity(args.active_root_path, active_root_fd)
    finally:
        os.close(artifact_root_fd)
        os.close(active_root_fd)


try:
    main()
except Exception as error:
    sys.stderr.write(f"{error}\n")
    sys.exit(1)
