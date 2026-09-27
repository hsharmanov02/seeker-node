"""Base class for buyer seekers.

A seeker knows how to check ONE real source of demand and return
opportunities in a standard shape:

    {
        "id":      unique string, e.g. "hn-41234567",
        "source":  seeker name, e.g. "hn_hiring",
        "title":   short human title,
        "url":     link to the original post,
        "snippet": first ~300 chars of the post,
    }

Seekers must never crash the node: wrap network code in try/except and
return [] on failure. The node logs the failure.
"""


class Seeker:
    name = "base"

    def find(self, config):
        """Return a list of opportunity dicts. Must not raise."""
        raise NotImplementedError
