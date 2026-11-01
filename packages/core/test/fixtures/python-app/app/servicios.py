import logging
from typing import Optional

from . import modelos
from .repositorio import Repositorio

log = logging.getLogger(__name__)


class ClienteService:
    def __init__(self, repo: Optional[Repositorio] = None):
        self.repo = Repositorio()

    def registrar(self, nombre):
        cliente = self.repo.buscar(nombre)
        cliente.guardar()
        log.info("registrado")
        return modelos.Cliente(nombre)

    def _privado(self):
        pass
