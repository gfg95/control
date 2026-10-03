# Control

Clavier contrôleur MIDI dans le navigateur. Le son vient de
[TabSoundEngine](https://engine.tabmidi.app), piloté par son API IFrame (`iframe_api.js`).

- Clavier 25 touches (Do 3 – Do 5 par défaut), multi-touch, glissando, décalage d'octave.
- Canal MIDI d'émission au choix, de 1 à 16.
- Program Change : programmes 0 à 127, émis sur le canal courant.
- 8 potentiomètres assignables à n'importe quel CC (0–127), préréglés sur les paramètres du synthé FM.
- Sur téléphone : interface en paysage, synthé rangé derrière l'onglet « Synthé ».

## Lancer

```sh
npm install
npm run dev        # http://localhost:5173
npm run check      # types
npm run build      # build de production (adapter Vercel)
```

Node 22.17 ou plus récent (exigence de SvelteKit 3).

## Déployer sur Vercel

Importer le dépôt dans Vercel : le preset SvelteKit est détecté, sans réglage. Ou, en ligne de
commande, `npx vercel` puis `npx vercel --prod`. L'unique page est prérendue, donc servie en statique.

Variable d'environnement facultative :

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `VITE_TSE_ENGINE_URL` | `https://engine.tabmidi.app` | Origine du moteur (moteur local, préproduction). |

Si vous ajoutez une politique CSP, autorisez l'origine du moteur dans `script-src` et `frame-src`.

## Comportement

**Démarrage du son.** Le navigateur exige un geste : le premier appui sur une touche ou sur
« Activer le son » appelle `player.start()`. Le Player est créé avec `autostart: false` pour que
l'envoi des CC au chargement ne déclenche pas une tentative sans geste. Si le navigateur refuse
quand même (`needsGesture`), l'onglet « Synthé » passe devant pour laisser toucher le bouton de
l'iframe, puis l'interface revient aux contrôles dès que l'audio tourne.

**Canal.** Le synthé est créé en `omni` ; le canal choisi est celui sur lequel le contrôleur émet
notes et CC. Changer de canal relâche d'abord les notes tenues.

**Program Change.** Le bouton « Programme » ouvre une grille des 128 programmes, numérotés de 0 à
127 comme l'octet MIDI. Chaque case émet aussitôt, et la feuille reste ouverte pour essayer les
programmes à la suite. Le synthé FM actuel ignore ces messages.

**Potentiomètres.** Glisser vers le haut ou la droite, molette, ou flèches du clavier ; Maj ralentit ;
double-clic pour revenir à la valeur d'origine. Le nom sous le potentiomètre ouvre l'assignation.
Le programme puis les valeurs des CC sont renvoyés au synthé à chaque chargement, pour que l'écran
et le son concordent.

**Paysage imposé.** Sur un téléphone tenu en portrait, l'interface est pivotée de 90° en CSS : elle
est donc toujours en paysage, même avec le verrouillage de rotation du téléphone. Le bouton plein
écran verrouille en plus l'orientation là où le navigateur le permet (Android), et le manifeste
déclare `orientation: landscape` pour l'application installée sur l'écran d'accueil.

**Clavier d'ordinateur.** Rangée du bas (W à `,` en AZERTY) pour la première octave, rangée du haut
(A à I, avec les chiffres pour les touches noires) pour la seconde. Les touches sont lues par
position physique, donc identiques en QWERTY.

**Mémoire.** Canal, octave, programme et potentiomètres sont gardés dans le `localStorage` du navigateur.

## Organisation

```
src/lib/tse.ts                 chargement et types de l'API IFrame
src/lib/midi.ts                table des CC du synthé FM, noms de notes, touches d'ordinateur
src/lib/controller.svelte.ts   état du contrôleur et pont vers TSE.Player
src/lib/Keyboard.svelte        clavier 25 touches
src/lib/Knob.svelte            potentiomètre
src/lib/Sheet.svelte           feuille de réglage (canal, assignation)
src/routes/+page.svelte        mise en page, onglets, version mobile
```
