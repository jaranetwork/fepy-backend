#!/usr/bin/env node

/**
 * Script para crear un usuario administrador en el sistema SIFEN
 * Uso: node crear-admin.js [username] [email] [password] [nombre] [apellido]
 * 
 * Si no se proporcionan argumentos, el script los pedirá interactivamente
 */

const mongoose = require('mongoose');
const readline = require('readline');
const path = require('path');

// Cargar variables de entorno si existen
require('dotenv').config({ path: path.join(__dirname, '.env') });

// Importar modelo de Usuario
const User = require('./models/User');

// Configuración
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/sifen_db';
const DEFAULT_ADMIN = {
  username: 'admin',
  email: 'admin@sifen.gov.py',
  password: 'admin123',
  nombre: 'Administrador',
  apellido: 'SIFEN',
  rol: 'admin'
};

// Crear interfaz readline
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Función para hacer preguntas
const preguntar = (pregunta) => {
  return new Promise((resolve) => {
    rl.question(pregunta, (respuesta) => {
      resolve(respuesta);
    });
  });
};

// Función para crear el usuario administrador
async function crearAdmin(datos) {
  try {
    // Conectar a MongoDB
    console.log('📦 Conectando a MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Conectado a MongoDB');

    // Verificar si ya existe un admin
    const adminExistente = await User.findOne({ rol: 'admin' });
    if (adminExistente) {
      console.log('⚠️  Ya existe un usuario administrador:');
      console.log(`   Username: ${adminExistente.username}`);
      console.log(`   Email: ${adminExistente.email}`);
      console.log(`   Nombre: ${adminExistente.nombre} ${adminExistente.apellido}`);
      
      const sobrescribir = await preguntar('¿Deseas crear otro administrador? (s/n): ');
      if (sobrescribir.toLowerCase() !== 's') {
        console.log('❌ Operación cancelada');
        rl.close();
        await mongoose.disconnect();
        process.exit(0);
      }
    }

    // Verificar si el username ya existe
    const usernameExistente = await User.findOne({ username: datos.username });
    if (usernameExistente) {
      console.log(`❌ El username "${datos.username}" ya está en uso`);
      rl.close();
      await mongoose.disconnect();
      process.exit(1);
    }

    // Verificar si el email ya existe
    const emailExistente = await User.findOne({ email: datos.email });
    if (emailExistente) {
      console.log(`❌ El email "${datos.email}" ya está en uso`);
      rl.close();
      await mongoose.disconnect();
      process.exit(1);
    }

    // Crear usuario administrador
    console.log('\n📝 Creando usuario administrador...');
    const admin = new User(datos);
    await admin.save();

    console.log('\n✅ ¡Usuario administrador creado exitosamente!\n');
    console.log('┌─────────────────────────────────────────────────┐');
    console.log('│  DATOS DE ACCESO                                │');
    console.log('├─────────────────────────────────────────────────┤');
    console.log(`│  Username:  ${datos.username.padEnd(38)}│`);
    console.log(`│  Email:     ${datos.email.padEnd(38)}│`);
    console.log(`│  Password:  ${datos.password.padEnd(38)}│`);
    console.log(`│  Nombre:    ${datos.nombre} ${datos.apellido}${' '.repeat(37 - datos.nombre.length - datos.apellido.length)}│`);
    console.log(`│  Rol:       admin${' '.repeat(32)}│`);
    console.log('└─────────────────────────────────────────────────┘');
    console.log('\n⚠️  IMPORTANTE: Cambia la contraseña después del primer inicio de sesión\n');

    rl.close();
    await mongoose.disconnect();
    process.exit(0);

  } catch (error) {
    console.error('❌ Error al crear el usuario administrador:', error.message);
    rl.close();
    await mongoose.disconnect();
    process.exit(1);
  }
}

// Función principal
async function main() {
  console.log('╔═════════════════════════════════════════════════╗');
  console.log('║  SISTEMA DE FACTURACIÓN ELECTRÓNICA - SIFEN    ║');
  console.log('║  Crear Usuario Administrador                    ║');
  console.log('╚═════════════════════════════════════════════════╝\n');

  // Si se proporcionan argumentos por línea de comandos
  if (process.argv.length >= 7) {
    const datos = {
      username: process.argv[2],
      email: process.argv[3],
      password: process.argv[4],
      nombre: process.argv[5],
      apellido: process.argv[6],
      rol: 'admin'
    };
    await crearAdmin(datos);
    return;
  }

  // Modo interactivo
  console.log('Ingresa los datos del usuario administrador\n');
  console.log('(Presiona ENTER para usar los valores por defecto)\n');

  const username = await preguntar(`Username [${DEFAULT_ADMIN.username}]: `);
  const email = await preguntar(`Email [${DEFAULT_ADMIN.email}]: `);
  const password = await preguntar(`Contraseña [${DEFAULT_ADMIN.password}]: `);
  const nombre = await preguntar(`Nombre [${DEFAULT_ADMIN.nombre}]: `);
  const apellido = await preguntar(`Apellido [${DEFAULT_ADMIN.apellido}]: `);

  const datos = {
    username: username || DEFAULT_ADMIN.username,
    email: email || DEFAULT_ADMIN.email,
    password: password || DEFAULT_ADMIN.password,
    nombre: nombre || DEFAULT_ADMIN.nombre,
    apellido: apellido || DEFAULT_ADMIN.apellido,
    rol: 'admin'
  };

  await crearAdmin(datos);
}

// Ejecutar
main();
