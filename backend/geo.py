"""Region (state) names for the geo headers the host sends (Vercel: x-vercel-ip-country-region = ISO 3166-2 code).

Only India and the US are mapped -- the markets this tool is used in today; any other country falls back to the raw
code (rules can still match it, e.g. region is "ON"). No IP address is ever read or stored: the host resolves the
location before the request reaches us and we only forward its country / region / city labels to the visitor's own browser.
"""
from typing import Optional
from urllib.parse import unquote

IN = {
    "AN": "Andaman and Nicobar Islands", "AP": "Andhra Pradesh", "AR": "Arunachal Pradesh", "AS": "Assam", "BR": "Bihar",
    "CH": "Chandigarh", "CT": "Chhattisgarh", "CG": "Chhattisgarh", "DH": "Dadra and Nagar Haveli and Daman and Diu",
    "DD": "Dadra and Nagar Haveli and Daman and Diu", "DN": "Dadra and Nagar Haveli and Daman and Diu", "DL": "Delhi",
    "GA": "Goa", "GJ": "Gujarat", "HR": "Haryana", "HP": "Himachal Pradesh", "JK": "Jammu and Kashmir", "JH": "Jharkhand",
    "KA": "Karnataka", "KL": "Kerala", "LA": "Ladakh", "LD": "Lakshadweep", "MP": "Madhya Pradesh", "MH": "Maharashtra",
    "MN": "Manipur", "ML": "Meghalaya", "MZ": "Mizoram", "NL": "Nagaland", "OR": "Odisha", "OD": "Odisha",
    "PY": "Puducherry", "PB": "Punjab", "RJ": "Rajasthan", "SK": "Sikkim", "TN": "Tamil Nadu", "TG": "Telangana",
    "TS": "Telangana", "TR": "Tripura", "UP": "Uttar Pradesh", "UT": "Uttarakhand", "UK": "Uttarakhand", "WB": "West Bengal",
}
US = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California", "CO": "Colorado", "CT": "Connecticut",
    "DE": "Delaware", "DC": "District of Columbia", "FL": "Florida", "GA": "Georgia", "HI": "Hawaii", "ID": "Idaho",
    "IL": "Illinois", "IN": "Indiana", "IA": "Iowa", "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine",
    "MD": "Maryland", "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota", "MS": "Mississippi", "MO": "Missouri",
    "MT": "Montana", "NE": "Nebraska", "NV": "Nevada", "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico",
    "NY": "New York", "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma", "OR": "Oregon",
    "PA": "Pennsylvania", "RI": "Rhode Island", "SC": "South Carolina", "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas",
    "UT": "Utah", "VT": "Vermont", "VA": "Virginia", "WA": "Washington", "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming",
}
NAMES = {"IN": IN, "US": US}


def region_name(country: Optional[str], code: Optional[str]) -> Optional[str]:
    """'IN','MH' -> 'Maharashtra'; unknown country/code -> the code itself (or None when there is none)."""
    if not code:
        return None
    return NAMES.get((country or "").upper(), {}).get(code.upper(), code)


def location_from_headers(h) -> dict:
    """Country / region / city from CDN geo headers (Vercel, Cloudflare). Missing values are None."""
    country = h.get("cf-ipcountry") or h.get("x-vercel-ip-country") or None
    if country in {"XX", "T1"}:
        country = None
    code = h.get("x-vercel-ip-country-region") or h.get("cf-region-code") or None
    city = h.get("x-vercel-ip-city") or h.get("cf-ipcity") or None
    return {"country": country, "region": region_name(country, code) or h.get("cf-region") or None,
            "region_code": code, "city": unquote(city) if city else None}
