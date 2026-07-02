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
                    numero: data.portalNumber,
                    lat: data.lat,
                    lon: data.lng
                };
            }
        }
    } catch (error) {
        console.warn("Fallo al consultar CartoCiudad:", error.message);
    }
    return null;
}

// Escaneo en cuadrícula para obtener múltiples portales en un radio de ~100m usando CartoCiudad
async function queryCartoCiudadGrid(lat, lon) {
    const latOffset = 30 / 111111;
    const lonOffset = 30 / (111111 * Math.cos(lat * Math.PI / 180));
    const latOffsetDiag = latOffset * Math.SQRT1_2;
    const lonOffsetDiag = lonOffset * Math.SQRT1_2;

    const points = [
        { lat, lon },
        { lat: lat + latOffset, lon },
        { lat: lat - latOffset, lon },
        { lat, lon: lon + lonOffset },
        { lat, lon: lon - lonOffset },
        { lat: lat + latOffsetDiag, lon: lon + lonOffsetDiag },
        { lat: lat + latOffsetDiag, lon: lon - lonOffsetDiag },
        { lat: lat - latOffsetDiag, lon: lon + lonOffsetDiag },
        { lat: lat - latOffsetDiag, lon: lon - lonOffsetDiag }
    ];

    try {
        console.log(`Ejecutando escaneo en cuadrícula de CartoCiudad (9 puntos) alrededor de lat=${lat}, lon=${lon}`);
        const promises = points.map(p => queryCartoCiudad(p.lat, p.lon));
        const results = await Promise.all(promises);
        
        const unique = {};
        for (const r of results) {
            if (r) {
                const key = `${r.calle}-${r.numero}`;
                unique[key] = r;
            }
        }
        return Object.values(unique);
    } catch (error) {
        console.warn("Fallo en escaneo de cuadrícula CartoCiudad:", error.message);
    }
    return [];
}

// Función de consulta de unidades (pisos/locales) en la Sede Electrónica del Catastro de España
async function queryCatastroUnits(lat, lon) {
    try {
        // 1. Obtener la referencia catastral, municipio y provincia desde CartoCiudad
        const ccUrl = `https://www.cartociudad.es/geocoder/api/geocoder/reverseGeocode?lon=${lon}&lat=${lat}`;
        const ccResponse = await fetch(ccUrl, {
            headers: {
                'User-Agent': 'InfluenciaService/1.0.0 (https://infuencia.instala.xyz; info@instala.xyz)'
            }
        });
        if (!ccResponse.ok) throw new Error("Fallo al consultar CartoCiudad para geolocalizar la parcela.");
        
        const ccData = await ccResponse.json();
        const rc = ccData.refCatastral;
        const municipio = ccData.muni;
        const provincia = ccData.province;
        
        if (!rc) throw new Error("No se encontró referencia catastral para estas coordenadas.");
        
        console.log(`Consultando Catastro para RC: ${rc}, Municipio: ${municipio}, Provincia: ${provincia}`);
        
        // 2. Consultar el Catastro oficial (Consulta_DNPRC)
        const catastroUrl = `https://ovc.catastro.meh.es/ovcservweb/OVCSWLocalizacionRC/OVCCallejero.asmx/Consulta_DNPRC?Provincia=${encodeURIComponent(provincia)}&Municipio=${encodeURIComponent(municipio)}&RC=${encodeURIComponent(rc)}`;
        const catastroResponse = await fetch(catastroUrl);
        if (!catastroResponse.ok) throw new Error(`Fallo en el servidor del Catastro (${catastroResponse.status})`);
        
        const xmlText = await catastroResponse.text();
        
        // 3. Parsear el XML para extraer pisos y locales
        const units = [];
        
        // Caso A: XML contiene lcons/cons (Edificio Colectivo)
        if (xmlText.includes('<cons>')) {
            const consRegex = /<cons>([\s\S]*?)<\/cons>/g;
            let match;
            while ((match = consRegex.exec(xmlText)) !== null) {
                const consContent = match[1];
                const lcdMatch = consContent.match(/<lcd>(.*?)<\/lcd>/);
                const esMatch = consContent.match(/<es>(.*?)<\/es>/);
                const ptMatch = consContent.match(/<pt>(.*?)<\/pt>/);
                const puMatch = consContent.match(/<pu>(.*?)<\/pu>/);
                
                if (lcdMatch) {
                    const tipo = lcdMatch[1].trim();
                    const escalera = esMatch ? esMatch[1].trim() : '';
                    const planta = ptMatch ? ptMatch[1].trim() : '';
                    const puerta = puMatch ? puMatch[1].trim() : '';
                    
                    // Categorizar la unidad
                    let categoria = 'Otros';
                    const tipoUpper = tipo.toUpperCase();
                    if (tipoUpper.includes('VIVIENDA') || tipoUpper.includes('RESIDENCIAL')) {
                        categoria = 'Viviendas';
                    } else if (tipoUpper.includes('COMERCIO') || tipoUpper.includes('LOCAL') || tipoUpper.includes('OFICINA') || tipoUpper.includes('INDUSTRIAL')) {
                        categoria = 'Locales';
                    } else if (tipoUpper.includes('APARCAMIENTO') || tipoUpper.includes('ALMACEN') || tipoUpper.includes('TRASTERO')) {
                        categoria = 'Anexos';
                    }
                    
                    units.push({
                        tipo,
                        escalera,
                        planta,
                        puerta,
                        categoria
                    });
                }
            }
        } 
        // Caso B: XML contiene lrcdnp/rcdnp (Lista de inmuebles individuales)
        else if (xmlText.includes('<rcdnp>')) {
            const rcdnpRegex = /<rcdnp>([\s\S]*?)<\/rcdnp>/g;
            let match;
            while ((match = rcdnpRegex.exec(xmlText)) !== null) {
                const rcdnpContent = match[1];
                const esMatch = rcdnpContent.match(/<es>(.*?)<\/es>/);
                const ptMatch = rcdnpContent.match(/<pt>(.*?)<\/pt>/);
                const puMatch = rcdnpContent.match(/<pu>(.*?)<\/pu>/);
                
                const es = esMatch ? esMatch[1].trim() : '';
                const pt = ptMatch ? ptMatch[1].trim() : '';
                const pu = puMatch ? puMatch[1].trim() : '';
                
                let categoria = 'Viviendas';
                let tipo = 'Inmueble';
                
                const ptUpper = pt.toUpperCase();
                if (pt === '00' || ptUpper === 'BJ' || ptUpper === 'PB') {
                    categoria = 'Locales';
                    tipo = 'Local / Planta Baja';
                } else if (pt.startsWith('-') || ptUpper.includes('SS') || ptUpper.includes('S')) {
                    categoria = 'Anexos';
                    tipo = 'Sótano / Garaje';
                }
                
                units.push({
                    tipo,
                    escalera: es,
                    planta: pt,
                    puerta: pu,
                    categoria
                });
            }
        }
        
        // Obtener dirección oficial del Catastro
        const ldtMatch = xmlText.match(/<ldt>(.*?)<\/ldt>/);
        const direccionOficial = ldtMatch ? ldtMatch[1].trim() : `${ccData.tip_via || ''} ${ccData.address || ''} ${ccData.portalNumber || ''}`;
        
        return {
            refCatastral: rc,
            direccionOficial,
            municipio,
            provincia,
            codigoPostal: ccData.postalCode,
            unidades: units
        };
        
    } catch (error) {
        console.error("Error en queryCatastroUnits:", error.message);
        throw error;
    }
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

        const overpassQuery = `
            [out:json][timeout:30];
            // 1. Encontrar las calles transitables cerca del punto
            way(around:40, ${lat}, ${lon})["highway"]->.calles;
            // 2. Obtener los portales asociados exclusivamente a los nombres de esas calles en el entorno
            (
              node(around.calles:100)["addr:housenumber"]["addr:street"];
              way(around.calles:100)["addr:housenumber"]["addr:street"];
              relation(around.calles:100)["addr:housenumber"]["addr:street"];
            );
            out body geom;
        `;
        
        const data = await queryOverpassWithFailover(overpassQuery);
        
        let direccionesCRUDAS = data.elements
            .filter(el => el.tags && el.tags["addr:street"] && el.tags["addr:housenumber"])
            .map(el => {
                let elementLat = el.lat;
                let elementLon = el.lon;
                if (!elementLat && el.center) {
                    elementLat = el.center.lat;
                    elementLon = el.center.lon;
                }
                if (!elementLat && el.geometry && el.geometry.length > 0) {
                    elementLat = el.geometry[0].lat;
                    elementLon = el.geometry[0].lon;
                }
                return {
                    calle: el.tags["addr:street"],
                    numero: el.tags["addr:housenumber"],
                    lat: elementLat,
                    lon: elementLon
                };
            });

        const callesCercanas = [
            ...new Set(
                data.elements
                    .filter(el => el.tags && el.tags["highway"] && el.tags["name"])
                    .map(el => el.tags["name"])
            )
        ];

        // Fallback a CartoCiudad Grid si no hay resultados en Overpass
        if (direccionesCRUDAS.length === 0) {
            console.log("No se encontraron direcciones en Overpass. Consultando fallback CartoCiudad Grid...");
            const fallbackAddresses = await queryCartoCiudadGrid(Number(lat), Number(lon));
            if (fallbackAddresses && fallbackAddresses.length > 0) {
                console.log("Direcciones fallback encontradas en cuadrícula:", fallbackAddresses.length);
                direccionesCRUDAS.push(...fallbackAddresses);
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
                    content: "Eres un formateador experto para despliegues de fibra óptica. Tu tarea es organizar los portales recibidos. Si detectas locales o una finca, sepáralos de la siguiente forma exacta:\n\nArea de influencia:\n- Calle Principal 2 (Locales: A, B ; Pisos: 1ºA, 1ºB, 2ºA, 2ºB)\n- Calle Principal 4 (Planta Baja Comercial, Piso 1)\n- Calle Secundaria 1, 3, 5\n\nNo inventes datos. Si no hay pisos detallados, muestra solo los números de portal de forma lineal. No uses Markdown."
                },
                {
                    role: "user",
                    content: JSON.stringify(direccionesCRUDAS.map(d => ({ calle: d.calle, numero: d.numero })))
                }
            ],
            model: "llama-3.1-8b-instant",
            temperature: 0.1,
        });

        const resultado = chatCompletion.choices[0]?.message?.content?.trim();
        
        // Si se pide en formato JSON, devolvemos tanto el texto formateado como el array estructurado con coordenadas
        if (req.query.format === 'json') {
            return res.json({
                resultado: resultado,
                direcciones: direccionesCRUDAS
            });
        }

        res.header("Content-Type", "text/plain; charset=utf-8");
        res.send(resultado);

    } catch (error) {
        console.error("Error en el servidor:", error);
        res.status(500).send(`Error interno: ${error.message}`);
    }
});

// Nueva ruta para obtener el desglose catastral detallado de un portal exacto (pisos/locales) por coordenadas
app.get('/catastro/detalles', async (req, res) => {
    const { lat, lon } = req.query;
    if (!lat || !lon || isNaN(Number(lat)) || isNaN(Number(lon))) {
        return res.status(400).json({ error: "Parámetros 'lat' y 'lon' requeridos y deben ser numéricos." });
    }
    
    try {
        const info = await queryCatastroUnits(Number(lat), Number(lon));
        res.json(info);
    } catch (err) {
        res.status(500).json({ error: "Error consultando el Catastro", details: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Servidor ejecutándose en el puerto ${PORT}`);
});
