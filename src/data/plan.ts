// Vorbelegung aus Simons Trainingsplan (Vault: 03 Bereiche/Trainingsplan.md, Stand 27.10.2026).
// Wird nur angelegt, wenn beim Server noch nichts liegt; danach ändert Simon alles in der App.

export interface PlanExercise {
  name: string;
  sets: number;
  unilateral: boolean;
  note?: string;
}

export const PLAN: { name: string; exercises: PlanExercise[] }[] = [
  {
    name: 'Torso',
    exercises: [
      { name: 'Butterfly (Maschine)', sets: 2, unilateral: false },
      { name: 'Kabel-Flys von unten nach oben', sets: 2, unilateral: false, note: 'Bank zwischen den Kabeltürmen, Griffe unten, für die obere Brust' },
      { name: 'Seitheben', sets: 3, unilateral: false },
      { name: 'Enges Rudern, Maschine mit Brustpolster', sets: 2, unilateral: true, note: 'erste Rückenübung; Zug eng am Körper' },
      { name: 'T-Bar-Rudern', sets: 2, unilateral: false },
      { name: 'Latzug breit, Maschine', sets: 2, unilateral: false, note: 'beidarmig, für die unteren Latfasern' },
      { name: 'Reverse Flys', sets: 1, unilateral: true },
      { name: 'Frontheben am Kabel', sets: 2, unilateral: true },
      { name: 'Außenrotation', sets: 2, unilateral: true },
      { name: 'Unterarme am Kabel (einrollen und aufrollen)', sets: 2, unilateral: true },
      { name: 'Reverse Flys', sets: 1, unilateral: true, note: 'zweiter Satz am Ende' },
      { name: 'Hyperextensions', sets: 2, unilateral: false, note: 'Fokus Rückenstrecker: Rücken bewusst einrunden und wieder strecken' },
    ],
  },
  {
    name: 'Limbs',
    exercises: [
      { name: 'Trizepsdrücken am Kabel mit Manschette', sets: 3, unilateral: true },
      { name: 'Preacher Curls', sets: 3, unilateral: true },
      { name: 'Beinbeuger sitzend', sets: 2, unilateral: false },
      { name: 'Beinstrecker an der Maschine', sets: 2, unilateral: true },
      { name: 'Adduktoren-Maschine', sets: 2, unilateral: false },
      { name: 'Hackenschmidt (Hack Squat)', sets: 2, unilateral: false },
      { name: 'Cable Crunches am Latzug', sets: 2, unilateral: false, note: 'Arme raus, nur einrollen' },
      { name: 'Wadenheben an der Beinpresse', sets: 2, unilateral: false },
      { name: 'Booty Builder', sets: 2, unilateral: false },
    ],
  },
];
