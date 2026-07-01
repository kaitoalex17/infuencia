import express from 'express';
import Groq from 'groq-sdk';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3006;

// Inicializa Groq (Asegúrate de pasarle la API KEY por entorno o tenerla definida)
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || '' });

// Lista de servidores Overpass públicos alternativos para failover
const OVERPASS_ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://lz4.overpass-api.de/api/interpreter',
    'https://z.overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
];

async function queryOverpassWithFailover(query) {
    let lastError = null;
    for (const endpoint of OVERPASS_ENDPOINTS) {
        try {
            console.log(`Intentando conectar a Overpass en: ${endpoint}`);
            const overpassUrl = `${endpoint}?data=${encodeURIComponent(query)}`;
            
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout
            
            const response = await fetch(overpassUrl, { 
                signal: controller.signal,
                headers: {
                    'User-Agent': 'InfluenciaService/1.0.0 (https://infuencia.instala.xyz; info@instala.xyz)'
                }
            });
            clearTimeout(timeoutId);
            
            if (response.ok) {
                const data = await response.json();
                return data;
            } else {
                const text = await response.text();
                throw new Error(`Servidor respondió con código ${response.status}: ${text.substring(0, 80)}`);
            }
        } catch (error) {
            console.warn(`Error en el servidor Overpass (${endpoint}):`, error.message);
            lastError = error;
        }
    }
    throw new Error(`Todos los servidores Overpass fallaron. Último error: ${lastError ? lastError.message : 'Desconocido'}`);
}

// Función de geocodificación inversa con CartoCiudad (oficial en España) como fallback
async function queryCartoCiudad(lat, lon) {
    try {
        console.log(`Intentando conectar a CartoCiudad para fallback: lat=${lat}, lon=${lon}`);
        const url = `https://www.cartociudad.es/geocoder/api/geocoder/reverseGeocode?lon=${lon}&lat=${lat}`;
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'InfluenciaService/1.0.0 (https://infuencia.instala.xyz; info@instala.xyz)'
            }
        });
        if (response.ok) {
            const data = await response.json();
            if (data && data.address && data.portalNumber) {
                const tipoVia = (data.tip_via || 'Calle').toLowerCase();
                const tipoViaCapitalized = tipoVia.charAt(0).toUpperCase() + tipoVia.slice(1);
                return {
                    calle: `${tipoViaCapitalized} ${data.address}`,
                    numero: data.portalNumber
                };
            }
        }
    } catch (error) {
        console.warn("Fallo al consultar CartoCiudad:", error.message);
    }
    return null;
}

app.use(express.json());
// Servir el buscador estático si entran a la raíz
app.use(express.static(path.join(__dirname, 'public')));

// Ruta solicitada: /dir/latitud,longitud
app.get('/dir/:coordenadas', async (req, res) => {
    try {
        const coordsRaw = req.params.coordenadas; // Captura "36.608761,-4.519520"
        const [lat, lon] = coordsRaw.split(',').map(c => c.trim());

        if (!lat || !lon || isNaN(Number(lat)) || isNaN(Number(lon))) {
            return res.status(400).json({ error: "Formato de coordenadas incorrecto. Use: lat,lon" });
        }

        const radio = 100;
        const overpassQuery = `
            [out:json][timeout:25];
            (
              nwr["addr:housenumber"](around:${radio}, ${lat}, ${lon});
              way["highway"](around:${radio}, ${lat}, ${lon});
            );
            out body geom;
        `;
        
        const data = await queryOverpassWithFailover(overpassQuery);
        
        let direccionesCRUDAS = data.elements
            .filter(el => el.tags && el.tags["addr:street"] && el.tags["addr:housenumber"])
            .map(el => ({
                calle: el.tags["addr:street"],
                numero: el.tags["addr:housenumber"]
            }));

        const callesCercanas = [
            ...new Set(
                data.elements
                    .filter(el => el.tags && el.tags["highway"] && el.tags["name"])
                    .map(el => el.tags["name"])
            )
        ];

        if (direccionesCRUDAS.length === 0) {
            console.log("No se encontraron direcciones en Overpass. Consultando fallback CartoCiudad...");
            const fallbackAddress = await queryCartoCiudad(lat, lon);
            if (fallbackAddress) {
                console.log("Dirección fallback encontrada:", fallbackAddress);
                direccionesCRUDAS.push(fallbackAddress);
            }
        }

        if (direccionesCRUDAS.length === 0) {
            res.header("Content-Type", "text/plain; charset=utf-8");
            if (callesCercanas.length > 0) {
                return res.send(`Area de influencia: No se encontraron viviendas numeradas en este radio. Calles más cercanas: ${callesCercanas.join(', ')}`);
            } else {
                return res.send("Area de influencia: No se encontraron viviendas con numeración ni calles registradas en este radio.");
            }
        }

        // Llamada a Groq para formatear
        const chatCompletion = await groq.chat.completions.create({
            messages: [
                {
                    role: "system",
                    content: "Eres un formateador de datos estricto. Agrupa las direcciones por calle y genera una lista de números separados por comas. El formato de salida debe ser exactamente: 'Area de influencia: Calle X 1,2,3 ; Calle Y 4,5,6'. No devuelvas nada más."
                },
                {
                    role: "user",
                    content: JSON.stringify(direccionesCRUDAS)
                }
            ],
            model: "llama-3.1-8b-instant",
            temperature: 0.1,
        });

        const resultado = chatCompletion.choices[0]?.message?.content?.trim();
        
        // Respondemos en texto plano (fácil para que tu App lo consuma directamente)
        res.header("Content-Type", "text/plain; charset=utf-8");
        res.send(resultado);

    } catch (error) {
        console.error("Error en el servidor:", error);
        res.status(500).send(`Error interno: ${error.message}`);
    }
});

app.listen(PORT, () => {
    console.log(`Servidor ejecutándose en el puerto ${PORT}`);
});
