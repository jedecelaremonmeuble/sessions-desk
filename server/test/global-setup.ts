// Compile le pilote une fois pour toute la suite (sauf SD_DRIVER_EXE fourni, ex. un exe déjà publié).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { DRIVER_EXE, REPO } from './helpers.ts';

export default function setup(): void {
  if (process.env.SD_DRIVER_EXE) {
    if (!existsSync(process.env.SD_DRIVER_EXE)) throw new Error(`SD_DRIVER_EXE introuvable : ${process.env.SD_DRIVER_EXE}`);
    return;
  }
  execFileSync('dotnet', ['build', `${REPO}/driver/SessionsDesk.Driver.csproj`, '-c', 'Release', '-o', `${REPO}/.build/driver`, '-nologo', '-v', 'q'],
    { stdio: 'inherit' });
  if (!existsSync(DRIVER_EXE)) throw new Error(`pilote non produit : ${DRIVER_EXE}`);
}
