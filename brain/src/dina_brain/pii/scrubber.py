"""PII scrubber — detects and redacts personal information.

Combines spaCy NER (en_core_web_sm) for entity recognition with
regex patterns for structured PII (emails, phones, SSNs).
Raw data never leaves the Home Node.
"""
