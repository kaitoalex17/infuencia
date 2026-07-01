import express from 'express';
import Groq from 'groq-sdk';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3006;

// Inicializa Groq (Asegúrate de pasarle la API KEY por entorno o tenerla definida)
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || '' });

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
              node["addr:housenumber"](around:${radio}, ${lat}, ${lon});
              way["addr:housenumber"](around:${radio}, ${lat}, ${lon});
            );
            out body geom;
        `;
        
        const overpassUrl = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(overpassQuery)}`;
        const response = await fetch(overpassUrl);
        if (!response.ok) throw new Error('Error al consultar Overpass API');
        
        const data = await response.json();
        const direccionesCRUDAS = data.elements
            .filter(el => el.tags && el.tags["addr:street"] && el.tags["addr:housenumber"])
            .map(el => ({
                calle: el.tags["addr:street"],
                numero: el.tags["addr:housenumber"]
            }));

        if (direccionesCRUDAS.length === 0) {
            res.header("Content-Type", "text/plain; charset=utf-8");
            return res.send("Area de influencia: No se encontraron viviendas con numeración en este radio.");
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
        console.error(error);
        res.status(500).send("Error interno procesando el área de influencia.");
    }
});

app.listen(PORT, () => {
    console.log(`Servidor ejecutándose en el puerto ${PORT}`);
});
