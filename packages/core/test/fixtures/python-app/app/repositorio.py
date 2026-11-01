from .modelos import Cliente


class Repositorio:
    def buscar(self, nombre: str) -> Cliente:
        return Cliente(nombre)
