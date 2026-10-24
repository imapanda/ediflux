# Reads the output of "docker compose logs postgres" (with log_autovacuum_min_duration=0) and
# prints one CSV row per autovacuum of the database given with -v db=<name>:
#   time, table, pages_total, tuples_removed, tuples_remain, dead_not_yet_removable, elapsed_s
# Used by run.sh for the long run. Only "automatic vacuum" blocks are kept, not analyzes.
BEGIN { print "time,table,pages_total,tuples_removed,tuples_remain,dead_not_yet_removable,elapsed_s" }

/automatic vacuum of table "/ {
  split($0, quoted, "\"")
  name = quoted[2]
  if (index(name, db ".") != 1) { inblock = 0; next }
  sub("^" db "[.]", "", name)
  stamp = $4
  inblock = 1
  pages = removed = remain = dead = elapsed = ""
  next
}

inblock && /pages: / {
  # pages: 0 removed, 45 remain, 12 scanned (...)
  if (match($0, /[0-9]+ remain/)) pages = substr($0, RSTART, RLENGTH - 7)
}

inblock && /tuples: / {
  # tuples: 800 removed, 3 remain, 2 are dead but not yet removable
  if (match($0, /[0-9]+ removed/)) removed = substr($0, RSTART, RLENGTH - 8)
  if (match($0, /[0-9]+ remain/)) remain = substr($0, RSTART, RLENGTH - 7)
  if (match($0, /[0-9]+ are dead/)) dead = substr($0, RSTART, RLENGTH - 9)
}

inblock && /system usage:/ {
  if (match($0, /elapsed: [0-9.]+/)) elapsed = substr($0, RSTART + 9, RLENGTH - 9)
  print stamp "," name "," pages "," removed "," remain "," dead "," elapsed
  inblock = 0
}
