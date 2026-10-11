"""Targeting rules: one definition shared by personalization campaigns, A/B-test audiences and saved segments.

A rule is `field op value`, evaluated in the visitor's browser by public/sdk.js (see `context()` and
`ruleMatches()` there -- keep the two lists in sync). The server only validates and stores them.
"""
import re
from typing import Optional

from fastapi import HTTPException
from pydantic import BaseModel, Field

# Built-in visitor facts the SDK can compute. Custom facts use "attr.<name>" (see OT.identify in sdk.js).
RULE_FIELDS = {
    # who they are
    "returning", "visit_no", "days_since_last", "days_since_first", "customer", "language", "device", "os", "browser",
    "country",
    # where they came from
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "referrer", "referrer_host", "search_keyword",
    "landing_page",
    # what they are doing / have done
    "url", "pages_viewed", "hour", "weekday", "did_event",
}
RULE_OPS = {"eq", "neq", "gte", "lte", "contains", "not_contains", "in", "starts"}
ATTR_FIELD = re.compile(r"^attr\.[A-Za-z][A-Za-z0-9_]{0,29}$")
MAX_RULES = 10
NUMERIC_OPS = {"gte", "lte"}


class Rule(BaseModel):
    field: str
    op: str = "eq"
    value: str = Field(default="", max_length=200)


def valid_field(field: str) -> bool:
    return field in RULE_FIELDS or bool(ATTR_FIELD.match(field or ""))


def validate_rules(rules: list, match: str = "all", what: str = "rule") -> None:
    if match not in {"all", "any"}:
        raise HTTPException(422, "match must be all or any")
    if len(rules) > MAX_RULES:
        raise HTTPException(422, f"too many {what}s (max {MAX_RULES})")
    for r in rules:
        if not valid_field(r.field) or r.op not in RULE_OPS:
            raise HTTPException(422, f"bad {what}: {r.field} {r.op}")
        if r.op in NUMERIC_OPS:
            try:
                float(r.value)
            except ValueError:
                raise HTTPException(422, f"'{r.field}' with ≥/≤ needs a number")
        if r.op == "in" and not [x for x in r.value.split(",") if x.strip()]:
            raise HTTPException(422, f"'{r.field} in' needs a comma-separated list")
        if r.field == "did_event" and not r.value.strip():
            raise HTTPException(422, "'did_event' needs an event name")


def clean_rules(rules: Optional[list]) -> list:
    return [Rule(field=r.field, op=r.op, value=r.value.strip()) for r in (rules or [])]
