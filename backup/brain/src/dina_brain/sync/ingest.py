"""Ingestion pipeline — processes raw connector output into vault items.

Normalizes data from different sources, applies PII scrubbing,
and stores structured items in the vault via dina-core.
"""
