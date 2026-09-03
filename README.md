# Consola Técnica Walchem — Filsa

App con backend propio: busca y lee los PDFs **completos y sin modificar** en Google Drive en el momento de cada pregunta, usando un *service account* de Google (no tu cuenta personal). Nadie que abra el link necesita loguearse en nada.

## Cómo funciona

1. El usuario escribe una pregunta en la web.
2. El servidor busca en Drive los PDFs más relevantes (usando el service account).
3. Descarga esos PDFs y extrae su texto completo (sin resumir).
4. Le pasa ese texto a Claude junto con la pregunta, y devuelve la respuesta con links a los documentos usados.

Como el service account solo tiene acceso a lo que vos le compartas, si le compartís **únicamente** la carpeta "Walchem", las búsquedas quedan acotadas a esa carpeta automáticamente.

---

## Paso 1 — Conseguir tu API key de Anthropic

1. Entrá a [console.anthropic.com](https://console.anthropic.com) → **API Keys** → **Create Key**.
2. Copiala, la vas a necesitar en el Paso 4.

*(Esto tiene costo por uso, separado de tu suscripción a Claude.ai — cada pregunta consume algunos centavos de crédito de API.)*

## Paso 2 — Crear el service account de Google

1. Andá a [console.cloud.google.com](https://console.cloud.google.com) y creá un proyecto nuevo (o usá uno existente).
2. En el buscador, andá a **APIs & Services → Library**, buscá "Google Drive API" y hacé clic en **Enable**.
3. Andá a **APIs & Services → Credentials → Create Credentials → Service Account**.
4. Ponele un nombre (ej. "walchem-drive-reader") y creálo. No hace falta darle ningún rol de proyecto.
5. Una vez creado, entrá al service account → pestaña **Keys** → **Add Key → Create new key → JSON**. Se descarga un archivo `.json` — **guardalo, es la credencial**.
6. Copiá el **email** del service account (termina en `.iam.gserviceaccount.com`, lo ves en la lista de service accounts).

## Paso 3 — Compartir la carpeta de Drive con el service account

1. Abrí Google Drive, buscá la carpeta **"Walchem"**.
2. Botón derecho → **Compartir** → pegá el email del service account (el que termina en `.iam.gserviceaccount.com`).
3. Dale permiso de **Lector** (Viewer) — es de solo lectura, no necesita más.

Con esto, el service account ya puede leer todo lo que está dentro de esa carpeta (y solo eso).

## Paso 4 — Desplegar en Render (gratis)

1. Creá una cuenta en [render.com](https://render.com) (podés loguearte con GitHub).
2. Subí esta carpeta a un repositorio de GitHub (o usá "Upload" si Render te lo permite directo).
3. En Render: **New → Web Service**, conectá el repo.
4. Configuración:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
5. En la sección **Environment Variables**, agregá:
   - `ANTHROPIC_API_KEY` → tu key del Paso 1
   - `GOOGLE_SERVICE_ACCOUNT_JSON` → abrí el archivo `.json` del Paso 2, copiá **todo** el contenido y pegalo como **una sola línea** (Render acepta JSON multilínea en el campo de valor, no hace falta que lo compactes a mano)
   - `WALCHEM_ROOT_FOLDER_ID` → `1Me1u_SbUb0YRuYJHgq0R6agpDs6RQt4n`
6. Deploy. Render te da una URL pública tipo `https://walchem-tech-assistant.onrender.com` — ese es el link que le pasás a tu equipo.

*Nota: el plan gratis de Render "duerme" el servicio tras 15 min sin uso, y tarda ~30-50 segundos en despertar en la primera consulta del día. Si eso molesta, el plan pago (~$7/mes) lo mantiene siempre activo.*

### Alternativa: Railway

Los pasos son equivalentes en [railway.app](https://railway.app) — conectás el repo, cargás las mismas 3 variables de entorno, y deploya. Railway no "duerme" el servicio en su plan gratuito inicial (con créditos limitados por mes).

## Paso 5 — Probarlo

Abrí la URL que te dio el hosting. Escribí una pregunta técnica real y confirmá que:
- Responde citando el documento correcto.
- El link del documento abre el PDF real en Drive.
- No pide login en ningún momento.

## Correr en tu computadora (opcional, para probar antes de desplegar)

```bash
npm install
cp .env.example .env
# completá .env con tus credenciales reales
npm start
# abrí http://localhost:3000
```

## Agregar más documentos después

No hace falta tocar el código: cualquier PDF que subas a la carpeta "Walchem" en Drive queda disponible automáticamente en la próxima búsqueda, porque el servidor lee Drive en vivo en cada pregunta.

## Ajustar cuánto texto se manda a Claude por pregunta

Las variables `MAX_CHARS_PER_DOC` (tope de caracteres por documento) y `MAX_DOCS_PER_QUERY` (cuántos documentos como máximo se leen por pregunta) se pueden subir o bajar en las variables de entorno sin tocar código. Valores más altos = respuestas más completas pero más costo de API por pregunta.
