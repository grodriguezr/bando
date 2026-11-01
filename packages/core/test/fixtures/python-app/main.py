from app import ClienteService


def principal():
    servicio = ClienteService()
    etiquetas = list(map(formatear, [1, 2]))
    servicio.registrar("Ana")
    desconocido(etiquetas)


def formatear(valor, *args: int, **opciones: str):
    opciones.setdefault("ancho", 10)
    return str(valor)


if __name__ == "__main__":
    principal()
