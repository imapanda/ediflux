#!/usr/bin/env python3
"""Turns the CSV files of perf/pgmq/results/ into the Markdown tables of
docs/research/pgmq-load-test.md (median and spread over the repeated runs).

    python3 -I perf/pgmq/summarize.py [results_dir]
"""

import csv
import statistics
import sys
from collections import defaultdict
from pathlib import Path

results = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).parent / "results")


def rows(name):
    path = results / name
    if not path.exists():
        return []
    with path.open(newline="") as handle:
        return list(csv.DictReader(handle))


def num(value):
    return float(value) if value not in ("", None) else None


def spread(values, digits=1):
    """median [min-max] of a list of numbers."""
    values = [v for v in values if v is not None]
    if not values:
        return "n/a"
    fmt = f"{{:.{digits}f}}"
    median = fmt.format(statistics.median(values))
    if len(values) == 1:
        return median
    return f"{median} [{fmt.format(min(values))}-{fmt.format(max(values))}]"


def table(header, body):
    print("| " + " | ".join(header) + " |")
    print("|" + "|".join(" --- " for _ in header) + "|")
    for line in body:
        print("| " + " | ".join(str(cell) for cell in line) + " |")
    print()


runs = rows("runs.csv")


def by_workers(mode):
    groups = defaultdict(list)
    for run in runs:
        if run["mode"] == mode:
            groups[int(run["workers"])].append(run)
    return dict(sorted(groups.items()))


def summary(title, mode):
    groups = by_workers(mode)
    if not groups:
        return
    print(f"### {title}\n")
    print("Median [min-max] over the runs of each setting.\n")
    body = []
    for workers, group in groups.items():
        col = lambda key: [num(r[key]) for r in group]  # noqa: E731
        body.append(
            [
                workers,
                len(group),
                spread(col("msg_s")),
                spread(col("p50_ms")),
                spread(col("p95_ms")),
                spread(col("p99_ms")),
                spread(col("max_ms"), 0),
                spread(col("wal_bytes_per_msg"), 0),
                spread(col("commits_per_msg")),
            ]
        )
    table(
        [
            "workers",
            "runs",
            "messages/s",
            "p50 ms",
            "p95 ms",
            "p99 ms",
            "max ms",
            "WAL bytes/msg",
            "commits/msg",
        ],
        body,
    )


def raw(title, modes):
    selected = [r for r in runs if r["mode"] in modes]
    if not selected:
        return
    print(f"### {title}\n")
    table(
        [
            "run",
            "offered msg/s",
            "completed in window",
            "messages/s",
            "p50 ms",
            "p95 ms",
            "p99 ms",
            "in flight at end",
            "autovacuums",
            "load average (1/5/15 min) before",
            "cores used by the test / by others",
        ],
        [
            [
                r["run_id"],
                r["offered_msg_s"] or "closed loop",
                r["completed_in_window"],
                r["msg_s"],
                r["p50_ms"],
                r["p95_ms"],
                r["p99_ms"],
                r["in_flight_at_end"],
                r["autovacuums"],
                r["loadavg_before"],
                f'{r["test_cores"]} / {r["other_cores"]}' if r["test_cores"] else "not recorded",
            ]
            for r in selected
        ],
    )


summary("Closed loop (workers also take in messages)", "closed")
raw("Raw runs, closed loop", {"closed"})
summary("Closed loop, no simulated external work (ceiling)", "ceiling")
raw("Raw runs, ceiling", {"ceiling"})
summary("Closed loop with synchronous_commit off (what-if)", "nosync")
raw("Raw runs, synchronous_commit off", {"nosync"})
raw("Open loop (a producer at a fixed rate, workers only consume)", {"open"})
raw("Soak run", {"soak"})

tables = rows("tables.csv")
if tables:
    print("### Table and index state at the end of each run\n")
    print(
        "From pgstattuple and pgstatindex, before any manual VACUUM; sizes in KiB. "
        "Median [min-max] over the runs of the same mode and worker count.\n"
    )
    groups = defaultdict(list)
    for t in tables:
        mode, workers, _rep = t["run_id"].split("-")  # <mode>-w<workers>-r<rep>
        groups[(mode, int(workers.removeprefix("w")), t["kind"], t["name"])].append(t)
    body = []
    for (mode, workers, kind, name), group in sorted(groups.items()):
        # The CSV has every table of every run; this page discusses the queues and `messages`
        # of the main matrix and of the long run.
        if not (mode == "soak" or (mode == "closed" and workers <= 8)):
            continue
        if not (name.startswith("pgmq.q_") or name == "fixture.messages"):
            continue
        col = lambda key: [num(r[key]) for r in group]  # noqa: E731
        if kind == "table":
            kib = [v / 1024 for v in col("heap_or_index_bytes") if v is not None]
            idx = [v / 1024 for v in col("index_bytes") if v is not None]
            body.append(
                [
                    mode,
                    workers,
                    name,
                    spread(kib, 0),
                    spread(idx, 0),
                    spread(col("n_tup_upd"), 0),
                    spread(col("n_tup_hot_upd"), 0),
                    spread(col("dead_pct")),
                    spread(col("free_pct")),
                    spread(col("autovacuum_count"), 0),
                ]
            )
    table(
        [
            "mode",
            "workers",
            "table",
            "heap KiB",
            "indexes KiB",
            "updates",
            "HOT updates",
            "dead tuples %",
            "free space %",
            "autovacuums",
        ],
        body,
    )
    body = []
    for (mode, workers, kind, name), group in sorted(groups.items()):
        if kind != "index" or not name.endswith("vt_idx"):
            continue
        if not (mode == "soak" or (mode == "closed" and workers <= 8)):
            continue
        col = lambda key: [num(r[key]) for r in group]  # noqa: E731
        body.append(
            [
                mode,
                workers,
                name,
                spread([v / 1024 for v in col("heap_or_index_bytes")], 0),
                spread(col("leaf_density_pct")),
            ]
        )
    print("Visibility-timeout index of each queue:\n")
    table(["mode", "workers", "index", "size KiB", "leaf density %"], body)

if tables and runs:
    print("### Storage per completed message at the end of a run\n")
    print(
        "Heap plus indexes, in bytes per message, grouped as in the fixture; median over the "
        "runs of the same mode and worker count. The three archive tables and the queue "
        "tables are those of pgmq.\n"
    )
    totals = {r["run_id"]: float(r["completed_total"]) for r in runs}
    groups = defaultdict(list)
    for t in tables:
        if t["kind"] != "table":
            continue
        name = t["name"]
        if name == "fixture.messages":
            part = "messages"
        elif name == "fixture.transitions":
            part = "transitions"
        elif name == "fixture.archive_refs":
            part = "archive_refs"
        elif name.startswith("pgmq.a_"):
            part = "pgmq archives (3)"
        elif name.startswith("pgmq.q_"):
            part = "pgmq queues (3)"
        else:
            continue
        size = float(t["heap_or_index_bytes"]) + float(t["index_bytes"] or 0)
        groups[(t["run_id"], part)].append(size)
    per_run = defaultdict(dict)
    for (run_id, part), sizes in groups.items():
        per_run[run_id][part] = sum(sizes) / totals[run_id]
    parts = ["messages", "transitions", "archive_refs", "pgmq archives (3)", "pgmq queues (3)"]
    modes = defaultdict(list)
    for run_id, values in per_run.items():
        mode, workers, _rep = run_id.split("-")
        modes[(mode, int(workers.removeprefix("w")))].append(values)
    body = []
    for (mode, workers), group in sorted(modes.items()):
        cells = [spread([v.get(p) for v in group], 0) for p in parts]
        total = spread([sum(v.get(p, 0) for p in parts) for v in group], 0)
        body.append([mode, workers, *cells, total])
    table(["mode", "workers", *parts, "total"], body)

timeline = rows("timeline.csv")
if timeline:
    print("### Soak run: time series\n")
    table(
        [
            "t (s)",
            "messages/s",
            "p95 ms",
            "queue heaps KiB",
            "queue indexes KiB",
            "queue dead tuples (estimate)",
            "queue autovacuums (total)",
            "messages heap KiB",
            "messages HOT updates / updates",
        ],
        [
            [
                r["t_s"],
                r["msg_s"],
                r["p95_ms"],
                round(float(r["queue_heap_bytes"]) / 1024),
                round(float(r["queue_index_bytes"]) / 1024),
                r["queue_dead_tup"],
                r["queue_autovacuums"],
                round(float(r["messages_heap_bytes"]) / 1024),
                f'{r["messages_hot_upd"]} / {r["messages_upd"]}',
            ]
            for r in timeline
        ],
    )
