# Bando

Bando te ayuda a entender rápido un proyecto JavaScript, TypeScript o Python que no conoces. Analiza el código fuente y te
muestra sus componentes, quién llama a quién y cómo se relacionan las carpetas; con IA (Claude o un modelo local)
explica cada archivo, cada carpeta, el proyecto completo y lo que ocurre cuando se ejecuta una función. Todo se puede
exportar como documentación en Markdown.

Bando solo lee el proyecto analizado: nunca lo modifica.

## Qué hace

- **Análisis estático** de archivos, clases, interfaces, funciones y métodos, imports, llamadas y herencia:
  - **JavaScript/TypeScript**, con el compilador de TypeScript: resuelve llamadas entre archivos y paquetes de un
    monorepo, patrones de React (`useCallback`, hooks, props) y objetos de servicios (`usuariosApi.listar`).
  - **Python**, con Tree-sitter: paquetes e imports relativos, herencia, `self`, tipos deducidos de asignaciones,
    anotaciones y `return`, y fixtures de pytest. Python no tiene tipos obligatorios, así que resuelve menos llamadas
    que TypeScript (en Flask y Requests queda sin resolver un 16-18 %, frente al 1-3 % de un proyecto TypeScript).
  - En un repositorio con ambos lenguajes, los analiza juntos en un solo grafo.
- **App de escritorio** (Electron):
  - Grafo de dependencias por carpetas que se abren y cierran, y grafo de llamadas de cada función.
  - Árbol de archivos, búsqueda, y panel con firma, documentación, relaciones y código.
  - Resúmenes con IA por archivo y carpeta, una **guía para empezar** con el proyecto y la **explicación de flujos**.
  - **Preguntar al proyecto**: respuestas a preguntas como "¿cómo se suspende un contrato?", basadas en las partes del
    código relacionadas y con enlaces a ellas.
  - "Resumir todo el proyecto" en segundo plano y exportación de la documentación.
- **CLI** con las mismas capacidades para la terminal.
- **Documentación en Markdown** lista para GitHub/GitLab: índice con la guía y un diagrama de la arquitectura, una
  página por carpeta y por archivo con enlaces a las líneas de código.

## Requisitos

- Node.js 24 (es la versión con la que se desarrolla y prueba; los tests usan la ejecución directa de TypeScript de Node).
- Para los resúmenes, una de estas opciones:
  - **Claude**: una clave de la API de Anthropic en `ANTHROPIC_API_KEY` (o una sesión de `ant auth login`).
  - **Modelo local**: cualquier servidor compatible con la API de OpenAI, como [LM Studio](https://lmstudio.ai)
    u [Ollama](https://ollama.com). Probado con Qwen2.5-Coder 14B en un Mac mini M4 de 16 GB.

## Instalación

```bash
npm install
npm run build
```

## App de escritorio

```bash
npm run desktop                          # abre la app; elige el proyecto con "Abrir proyecto"
npm run desktop -- /ruta/a/un/proyecto   # o ábrela directamente con un proyecto
```

Si el proyecto tiene `tsconfig.json`, Bando lo usa; en Python ignora los entornos virtuales (`venv`, `.venv`…); en un repositorio con varias partes (por ejemplo `backend/` y
`frontend/` con su propio `tsconfig.json`), abre cada parte por separado para obtener el análisis más preciso.

En la pestaña **Resumen** están la guía del proyecto, "Resumir todo" y "Exportar documentación". El selector junto a
cada resumen cambia entre Claude y el modelo local.

## CLI

```bash
npx bando analyze /ruta/al/proyecto -o graph.json   # analiza y muestra un resumen
npx bando inspect NombreDeFuncion                   # quién la llama y a quién llama
npx bando mermaid > dependencias.mmd                # diagrama de dependencias entre archivos

npx bando summarize src/servicios/clientes.ts       # resume un archivo o carpeta con IA
npx bando explain ClientesService.crear             # explica el flujo de una función
npx bando ask "¿Cómo se suspende un contrato?"      # responde una pregunta sobre el proyecto
npx bando guide                                     # guía "por dónde empezar"
npx bando summarize-all -j 4                        # resume todo (retoma si se interrumpe)
npx bando docs -o /ruta/de/salida                   # exporta la documentación en Markdown
```

Los comandos con IA usan Claude por defecto. Agrega `--local` para usar un modelo local
(`--url` cambia el servidor, por defecto `http://localhost:1234/v1` de LM Studio; `--model` elige el modelo).
Todos leen el grafo de `graph.json`; usa `-g` para otro archivo.

### Costos y tiempos de referencia

- **Claude Opus**: unos centavos de dólar por archivo resumido.
- **Modelo local**: gratis y privado. Con Qwen2.5-Coder 14B en un Mac mini M4, unos 40 s por archivo con 4 resúmenes
  en paralelo. Ajusta el paralelismo con `-j` si el equipo se queda sin memoria.

Los archivos sin lógica (tipos, constantes, traducciones) se resumen al instante sin IA, y cada resumen se guarda en
caché: solo se regenera cuando cambia el código o los resúmenes en los que se basa.

## Dónde guarda los datos

Los resúmenes se guardan fuera de los proyectos, en una caché compartida por la app y la CLI:

- macOS: `~/Library/Application Support/Bando`
- Linux: `~/.config/bando`
- Windows: `%APPDATA%\Bando`

La variable `BANDO_DATA_DIR` permite usar otra carpeta.

## Desarrollo

```
packages/
  core/      análisis, resúmenes con IA, caché y exportación de documentación (sin dependencias de UI)
  cli/       comando `bando`
  desktop/   app Electron + React + Cytoscape
```

```bash
npm test               # tests del core (node:test)
npm run typecheck      # verifica tipos en todos los paquetes
npm run format         # formatea con Prettier
npm run desktop        # app con recarga en caliente
```
