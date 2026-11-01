class Base:
    def guardar(self):
        return self._validar()

    def _validar(self):
        return True


class Cliente(Base):
    """Un cliente del sistema."""

    def __init__(self, nombre: str):
        super().__init__()
        self.nombre = nombre
