const http = {
  get: (url: string) => Promise.resolve(url),
};

/** Servicio de usuarios. */
export const usuariosApi = {
  listar: () => http.get("/usuarios"),
  crear(nombre: string) {
    return http.get(`/usuarios/${nombre}`);
  },
};
