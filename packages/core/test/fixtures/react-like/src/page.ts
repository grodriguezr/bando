import { usuariosApi } from "./api";
import { useCallback, useStateLike } from "./hooks";

export function Page() {
  const [, setNombre] = useStateLike("");
  const { log } = console;

  const cargar = useCallback(async () => {
    const lista = await usuariosApi.listar();
    setNombre(lista);
    log(lista);
  }, []);

  void cargar();
  usuariosApi.crear("x");

  // Which function runs is only known at runtime: must stay unresolved, not become Page → Page.
  const elegir = Math.random() > 0.5 ? () => 1 : () => 2;
  elegir();
}
