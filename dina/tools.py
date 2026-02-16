"""The Eyes — Dina's sensory layer for fetching external knowledge."""

from __future__ import annotations

import re

from youtube_transcript_api import YouTubeTranscriptApi

# Rough token estimate: 1 token ≈ 4 characters.
_CHARS_PER_TOKEN = 4
_MAX_TOKENS = 8000
_MAX_CHARS = _MAX_TOKENS * _CHARS_PER_TOKEN

_YT_URL_PATTERN = re.compile(
    r"(?:https?://)?(?:www\.|m\.)?(?:youtube\.com/watch\?v=|youtu\.be/)([\w-]{11})"
)


def is_youtube_url(text: str) -> bool:
    """Return True if the text contains a YouTube URL."""
    return _YT_URL_PATTERN.search(text) is not None


def extract_video_id(url: str) -> str:
    """Extract the 11-character video ID from a YouTube URL.

    Supports standard, shortened, and mobile YouTube URLs.
    """
    match = _YT_URL_PATTERN.search(url)
    if not match:
        raise ValueError(f"Could not extract a video ID from URL: {url}")
    return match.group(1)


def _truncate_middle(text: str, max_chars: int) -> str:
    """Keep the intro and outro of a transcript, trimming the middle.

    The intro provides context (what product, who's reviewing) and the
    outro usually contains the final verdict — both are critical for Dina.
    """
    if len(text) <= max_chars:
        return text

    half = max_chars // 2
    return text[:half] + "\n[...transcript truncated for context window...]\n" + text[-half:]


def fetch_youtube_transcript(url: str) -> str:
    """Fetch and return the transcript text for a YouTube video.

    If the transcript exceeds ~8 000 tokens it is truncated, keeping the
    intro (context) and outro (verdict) while trimming the middle.
    """
    video_id = extract_video_id(url)
    transcript_segments = YouTubeTranscriptApi().fetch(video_id)
    full_text = " ".join(segment.text for segment in transcript_segments)
    return _truncate_middle(full_text, _MAX_CHARS)
