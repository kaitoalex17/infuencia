# Servicio de Área de Influencia (100m)

Este es un microservicio en Node.js empaquetado en Docker que permite obtener y estructurar las direcciones con numeración en un radio de 100 metros a partir de coordenadas geográficas (latitud y longitud). Utiliza la API Overpass (OpenStreetMap) para recopilar los datos geográficos y la API de Groq con el modelo Llama 3.1 para formatear las direcciones en un formato limpio.

## Estructura del Proyecto

```text
influencia-service/
├── Dockerfile
├── docker-compose.yml
├── package.json
├── server.js
├── README.md
└── public/
    └── index.html
```

---

## Configuración de Credenciales

Para que el servicio pueda conectarse a la API de Groq, es necesario configurar la clave de API (`GROQ_API_KEY`). Aquí tienes cómo hacerlo según tu entorno de despliegue:

### 1. Despliegue en Portainer (Stack / Docker Compose)
Si despliegas utilizando el archivo `docker-compose.yml` provisto, debes actualizar la sección `environment`:

```yaml
    environment:
      - GROQ_API_KEY=tu_api_key_real_de_groq
```
Reemplaza `tu_api_key_real_de_groq` por tu credencial real obtenida desde la consola de Groq.

### 2. Ejecución Local (Desarrollo)
Para ejecutar el servidor directamente con Node.js en tu máquina, puedes crear un archivo `.env` en la raíz del proyecto (este archivo está configurado en `.gitignore` para no subirse a GitHub):

```env
GROQ_API_KEY=tu_api_key_real_de_groq
PORT=3006
```

Luego, instala la dependencia para cargar las variables o ejecútalo pasando la variable en la consola:
- **Linux/macOS:**
  ```bash
  GROQ_API_KEY="tu_api_key_real_de_groq" node server.js
  ```
- **Windows (PowerShell):**
  ```powershell
  $env:GROQ_API_KEY="tu_api_key_real_de_groq"; node server.js
  ```

---

## Instalación y Ejecución

### Requisitos Previos
- Node.js (versión 20 o superior)
- Docker y Docker Compose (opcional, para despliegue en contenedor)

### Ejecución Local

1. Instala las dependencias:
   ```bash
   npm install
   ```

2. Configura tu credencial `GROQ_API_KEY` (ver sección anterior).

3. Inicia el servidor de desarrollo:
   ```bash
   npm start
   ```
   El servidor estará disponible en [http://localhost:3006](http://localhost:3006).

### Ejecución con Docker Compose

1. Levanta el contenedor en segundo plano:
   ```bash
   docker-compose up -d --build
   ```

2. Accede a la interfaz web del buscador desde tu navegador en [http://localhost:3006](http://localhost:3006).

---

## Endpoints de la API

### 1. Interfaz Web (Buscador)
- **Ruta:** `GET /`
- **Descripción:** Carga una interfaz visual moderna e interactiva (con soporte para geolocalización en tiempo real y copiado rápido) para consultar las coordenadas manualmente.

### 2. Consulta de Coordenadas Directa
- **Ruta:** `GET /dir/:coordenadas`
- **Parámetro:** `:coordenadas` en formato `latitud,longitud` (ejemplo: `36.608761,-4.519520`).
- **Descripción:** Procesa el área de influencia y devuelve una respuesta en texto plano formateada por IA.
- **Ejemplo de respuesta:**
  `Area de influencia: Calle San Miguel 12, 14, 16 ; Calle Picasso 3, 5`
