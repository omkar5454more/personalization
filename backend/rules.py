"""Targeting rules: one definition shared by personalization campaigns, A/B-test audiences and saved segments.

A rule is `field op value`, evaluated in the visitor's browser by public/sdk.js (see `context()` and
`ruleMatches()` there -- keep the two lists in sync). The server only validates and stores them.

A *group* is a rule whose field is "__group": it carries its own `match` (all / any) and a list of plain rules, so
conditions like  plan = pro AND (device = mobile OR source = organic)  can be written. Groups nest one level only.
"""
import ipaddress
import re
from typing import Optional

from fastapi import HTTPException
from pydantic import BaseModel, Field, model_serializer

# Built-in visitor facts the SDK can compute.
RULE_FIELDS = {
    # who they are
    "returning", "visit_no", "days_since_last", "days_since_first", "customer", "language", "device", "os", "browser",
    "country", "region", "city",
    # where they came from
    "traffic_source", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "referrer", "referrer_host",
    "search_keyword", "landing_page",
    # what they are doing / have done
    "url", "pages_viewed", "total_pageviews", "hour", "weekday", "did_event", "visited_page",
    # network (the visitor's own IP is told to their browser by /ctx and compared there; it is never stored)
    "ip",
}
# Fields that carry a name after a dot:  attr.plan (OT.identify), param.utm_x (URL parameter of THIS page),
# cookie.tier (a cookie), var.user.plan (a JavaScript variable on the page).
DYNAMIC_FIELDS = {
    "attr": re.compile(r"^attr\.[A-Za-z][A-Za-z0-9_]{0,29}$"),
    "param": re.compile(r"^param\.[A-Za-z0-9_.\-\[\]]{1,60}$"),
    "cookie": re.compile(r"^cookie\.[A-Za-z0-9_\-]{1,40}$"),
    "var": re.compile(r"^var\.[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*){0,4}$"),
}
ATTR_FIELD = DYNAMIC_FIELDS["attr"]          # kept for older imports
RULE_OPS = {"eq", "neq", "gte", "lte", "contains", "not_contains", "in", "starts"}
MAX_RULES = 10
NUMERIC_OPS = {"gte", "lte"}
GROUP = "__group"
EXISTENCE_FIELDS = {"did_event", "visited_page"}      # "has / has not": only is / is not make sense


class Rule(BaseModel):
    field: str
    op: str = "eq"
    value: str = Field(default="", max_length=200)
    match: str = "all"                   # groups only
    rules: list["Rule"] = []             # groups only

    @model_serializer(mode="wrap")
    def _ser(self, handler):
        d = handler(self)
        if self.field != GROUP:          # keep stored/served plain rules in their original three-key shape
            d.pop("match", None)
            d.pop("rules", None)
        return d


Rule.model_rebuild()


def valid_field(field: str) -> bool:
    return field in RULE_FIELDS or any(p.match(field or "") for p in DYNAMIC_FIELDS.values())


def parse_ip_entries(value: str) -> list:
    """'203.0.113.7, 10.0.0.0/8, 192.168.1.10-192.168.1.50' -> list of valid entries; raises ValueError on a bad one."""
    entries = [x.strip() for x in value.split(",") if x.strip()]
    if not entries or len(entries) > 20:
        raise ValueError("enter 1-20 IP addresses, ranges (a.b.c.d-e.f.g.h) or CIDR blocks (a.b.c.d/24)")
    for e in entries:
        if "-" in e and "/" not in e:
            a, b = (x.strip() for x in e.split("-", 1))
            lo, hi = ipaddress.ip_address(a), ipaddress.ip_address(b)
            if lo.version != hi.version or lo > hi:
                raise ValueError(f"'{e}' is not a valid range")
        elif "/" in e:
            ipaddress.ip_network(e, strict=False)
        else:
            ipaddress.ip_address(e)
    return entries


def _validate_one(r: Rule, what: str) -> None:
    if not valid_field(r.field) or r.op not in RULE_OPS:
        raise HTTPException(422, f"bad {what}: {r.field} {r.op}")
    if r.op in NUMERIC_OPS:
        try:
            float(r.value)
        except ValueError:
            raise HTTPException(422, f"'{r.field}' with ≥/≤ needs a number")
    if r.op == "in" and not [x for x in r.value.split(",") if x.strip()]:
        raise HTTPException(422, f"'{r.field} in' needs a comma-separated list")
    if r.field == "ip":
        if r.op not in {"eq", "neq", "in"}:
            raise HTTPException(422, "'ip' supports 'is', 'is not' and 'is one of'")
        try:
            parse_ip_entries(r.value)
        except ValueError as e:
            raise HTTPException(422, str(e))
    if r.field in EXISTENCE_FIELDS:
        if not r.value.strip():
            raise HTTPException(422, f"'{r.field}' needs a value (an event name / part of a page address)")
        if r.op not in {"eq", "neq"}:
            raise HTTPException(422, f"'{r.field}' only supports 'has' / 'has not'")


def validate_rules(rules: list, match: str = "all", what: str = "rule", _depth: int = 0) -> None:
    if match not in {"all", "any"}:
        raise HTTPException(422, "match must be all or any")
    if len(rules) > MAX_RULES:
        raise HTTPException(422, f"too many {what}s (max {MAX_RULES})")
    for r in rules:
        if r.field == GROUP:
            if _depth >= 1:
                raise HTTPException(422, "groups can't be nested inside groups")
            if not r.rules:
                raise HTTPException(422, "a group needs at least one condition")
            validate_rules(r.rules, r.match, what, _depth + 1)
            continue
        _validate_one(r, what)


def clean_rules(rules: Optional[list]) -> list:
    out = []
    for r in rules or []:
        if r.field == GROUP:
            out.append(Rule(field=GROUP, match=r.match, rules=clean_rules(r.rules)))
        else:
            out.append(Rule(field=r.field, op=r.op, value=r.value.strip()))
    return out
