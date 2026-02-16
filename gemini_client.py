"""
Google Gemini/Vertex AI client
"""
import os
from google import genai
from google.genai import types
from .config import get_settings


class GeminiClient:
    def __init__(self):
        self.settings = get_settings()
        self._client = None

    def _setup_credentials(self):
        """Set up Google Cloud credentials"""
        if self.settings.vertex_ai_keyfile:
            os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = self.settings.vertex_ai_keyfile

    def get_client(self) -> genai.Client:
        """Get the Gemini client"""
        if self._client is None:
            self._setup_credentials()
            self._client = genai.Client(
                vertexai=True,
                project=self.settings.google_cloud_project,
                location=self.settings.google_cloud_location,
            )
        return self._client

    async def generate_response(
        self,
        prompt: str,
        system_instruction: str = None,
        temperature: float = 0.7,
        max_tokens: int = 2048,
    ) -> str:
        """Generate a response from Gemini"""
        client = self.get_client()

        config = types.GenerateContentConfig(
            temperature=temperature,
            max_output_tokens=max_tokens,
        )

        if system_instruction:
            config.system_instruction = system_instruction

        response = client.models.generate_content(
            model=self.settings.gemini_model,
            contents=[prompt],
            config=config,
        )

        return response.text

    async def chat(
        self,
        messages: list[dict],
        system_instruction: str = None,
        temperature: float = 0.7,
    ) -> str:
        """Multi-turn chat with Gemini"""
        client = self.get_client()

        # Convert messages to Gemini format
        contents = []
        for msg in messages:
            role = "user" if msg["role"] == "user" else "model"
            contents.append(types.Content(
                role=role,
                parts=[types.Part(text=msg["content"])]
            ))

        config = types.GenerateContentConfig(
            temperature=temperature,
        )

        if system_instruction:
            config.system_instruction = system_instruction

        response = client.models.generate_content(
            model=self.settings.gemini_model,
            contents=contents,
            config=config,
        )

        return response.text


# Singleton instance
_gemini_client = None


def get_gemini_client() -> GeminiClient:
    global _gemini_client
    if _gemini_client is None:
        _gemini_client = GeminiClient()
    return _gemini_client
