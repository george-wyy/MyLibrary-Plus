from __future__ import annotations

from abc import ABC, abstractmethod

import httpx

from ..schemas import PaperCandidate


class MetadataProvider(ABC):
    name: str

    def __init__(self, client: httpx.AsyncClient) -> None:
        self.client = client

    @abstractmethod
    async def search(self, query: str, kind: str) -> list[PaperCandidate]:
        raise NotImplementedError

