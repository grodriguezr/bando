import { usuariosApi } from "./api";

function formatear(n: number): string {
  return n.toFixed(1);
}

export function Boton() {
  const guardar = () => usuariosApi.crear("y");
  const etiquetas = [1, 2].map(formatear);
  setTimeout(guardar, 10);
  return <button onClick={guardar}>{etiquetas.join(", ")}</button>;
}
