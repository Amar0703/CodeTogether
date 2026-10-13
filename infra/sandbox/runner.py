"""Runs ONLY inside the constrained sandbox image. No host execution fallback."""
import json
import os
import resource
import selectors
import signal
import subprocess
import sys
import time

OUTPUT = 65536
used = 0
truncated = False
started = time.monotonic()

def send(value):
    print(json.dumps(value, ensure_ascii=True), flush=True)

def limits(cpu):
    def apply():
        resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu))
        resource.setrlimit(resource.RLIMIT_FSIZE, (16 * 1024 * 1024,) * 2)
        resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    return apply

def stage(args, stdin, deadline, cpu):
    global used, truncated
    with open('/work/stdin', 'wb') as f:
        f.write(stdin.encode('utf-8'))
    with open('/work/stdin', 'rb') as f:
        p = subprocess.Popen(args, stdin=f, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             cwd='/work', env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/work', 'LANG': 'C.UTF-8'},
                             start_new_session=True, preexec_fn=limits(cpu))
    poll = selectors.DefaultSelector()
    for pipe, name in [(p.stdout, 'stdout'), (p.stderr, 'stderr')]:
        os.set_blocking(pipe.fileno(), False)
        poll.register(pipe, selectors.EVENT_READ, name)
    until = time.monotonic() + deadline
    timed_out = False
    pending = {'stdout': bytearray(), 'stderr': bytearray()}
    last_flush = time.monotonic()
    def flush():
        for stream, data in pending.items():
            while data:
                part = bytes(data[:1024])
                del data[:1024]
                send({'kind': 'output', 'stream': stream, 'text': part.decode('utf-8', errors='replace')})
    try:
        while poll.get_map():
            if time.monotonic() >= until:
                timed_out = True
                break
            for key, _ in poll.select(0.05):
                data = os.read(key.fileobj.fileno(), 3072)
                if not data:
                    poll.unregister(key.fileobj)
                    continue
                remaining = OUTPUT - used
                if len(data) > remaining:
                    truncated = True
                # Stop after aggregate output limit, including compiler diagnostics.
                data = data[:remaining]
                used += len(data)
                pending[key.data].extend(data)
                if truncated:
                    break
            if truncated:
                break
            if time.monotonic() - last_flush >= 0.25 or sum(len(v) for v in pending.values()) >= 8192:
                flush()
                last_flush = time.monotonic()
        try:
            code = p.wait(timeout=max(0.01, until - time.monotonic())) if not truncated and not timed_out else None
        except subprocess.TimeoutExpired:
            timed_out = True
            code = None
    finally:
        flush()
        # Kill process group even after its parent exits. Container removal catches setsid descendants.
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        p.wait()
        poll.close()
        p.stdout.close()
        p.stderr.close()
    return code, timed_out

def main():
    data = json.loads(sys.stdin.buffer.readline(400000))
    commands = {'javascript': ('main.js', ['/usr/local/bin/node', '--max-old-space-size=128', '/work/main.js']),
                'python': ('main.py', ['/usr/bin/python3', '-I', '/work/main.py']),
                'cpp': ('main.cpp', ['/work/program'])}
    name, command = commands[data['language']]
    with open('/work/' + name, 'w', encoding='utf-8') as f:
        f.write(data['source'])
    phase = 'run'
    if data['language'] == 'cpp':
        phase = 'compile'
        code, timeout = stage(['/usr/bin/g++', '-std=c++20', '-O0', '-pipe', '/work/main.cpp', '-o', '/work/program'], '', 10, 10)
        if code == 0 and not timeout and not truncated:
            phase = 'run'
        else:
            finish(code, timeout, phase)
            return
    send({'kind': 'phase', 'phase': 'run'})
    code, timeout = stage(command, data['stdin'], 3, 2)
    finish(code, timeout, phase)

def finish(code, timeout, phase):
    status = 'TIMED_OUT' if timeout else 'SUCCEEDED' if code == 0 and not truncated else 'FAILED'
    failure = ('RESOURCE_LIMIT' if truncated or timeout or (code is not None and code < 0)
               else None if code == 0 else 'COMPILE_ERROR' if phase == 'compile' else 'RUNTIME_ERROR')
    send({'kind': 'result', 'result': {'status': status, 'failure': failure, 'exitCode': code,
          'durationMs': min(60000, int((time.monotonic() - started) * 1000)), 'truncated': truncated}})

if __name__ == '__main__':
    main()
