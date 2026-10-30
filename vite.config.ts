import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import {cp,mkdir} from 'node:fs/promises';
import path from 'node:path';
export default defineConfig({ plugins: [react(),{name:'local-pdf-resources',async closeBundle(){await mkdir('dist/pdfjs',{recursive:true});for(const name of ['cmaps','standard_fonts','wasm','iccs'])await cp(path.resolve('node_modules/pdfjs-dist',name),path.resolve('dist/pdfjs',name),{recursive:true});}}], build: { outDir: 'dist' } });
