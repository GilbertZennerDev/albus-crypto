export const CMD = "irm https://albus.workflowsolved.com/releases/install-albus.ps1 | iex";

export const D = {
  de: {
    kicker: "In 3 Minuten loslegen",
    h: "Lade den Albus-Miner herunter",
    p: "Kostenlose App für Windows. Sie richtet alles ein, schürft auf deinem eigenen PC und aktualisiert sich selbst.",
    btn: "Für Windows herunterladen",
    steps: ["Klick auf den großen Knopf. Eine kleine Datei <code>install-albus.ps1</code> wird gespeichert.", "Rechtsklick darauf und <i>Mit PowerShell ausführen</i> wählen.", "Das Miner-Fenster öffnet sich im Browser. Dort legst du deine Wallet an."],
    fast: "Schneller: Füge stattdessen diese eine Zeile in PowerShell ein.",
    copy: "Kopieren", copied: "Kopiert",
    notes: ["Du brauchst Node.js und PowerShell 7. Der Installer bietet an, sie für dich zu holen.", "Jedes Update ist vom Albus-Herausgeber signiert und wird auf deinem PC geprüft. Deine Wallet und deine Schlüssel verlassen ihn nie.", "Das Programm ist noch nicht code-signiert, deshalb kann Windows warnen. Lies das Skript gern vorher, es ist kurz."]
  },
  en: {
    kicker: "Start mining in 3 minutes",
    h: "Download the Albus miner",
    p: "Free app for Windows. It sets everything up, mines on your own PC and updates itself.",
    btn: "Download for Windows",
    steps: ["Click the big button. A small file <code>install-albus.ps1</code> is saved.", "Right-click it and choose <i>Run with PowerShell</i>.", "The miner window opens in your browser. Create your wallet there."],
    fast: "Faster: paste this one line into PowerShell instead.",
    copy: "Copy", copied: "Copied",
    notes: ["You need Node.js and PowerShell 7. The installer offers to get them for you.", "Every update is signed by the Albus publisher and checked on your PC. Your wallet and keys never leave it.", "The program is not code-signed yet, so Windows may show a warning. Read the script first if you like, it is short."]
  },
  fr: {
    kicker: "Commence en 3 minutes",
    h: "Télécharge le mineur Albus",
    p: "Application gratuite pour Windows. Elle installe tout, mine sur ton propre PC et se met à jour toute seule.",
    btn: "Télécharger pour Windows",
    steps: ["Clique sur le gros bouton. Un petit fichier <code>install-albus.ps1</code> est enregistré.", "Clique dessus avec le bouton droit et choisis <i>Exécuter avec PowerShell</i>.", "La fenêtre du mineur s'ouvre dans ton navigateur. Tu y crées ton portefeuille."],
    fast: "Plus rapide : colle plutôt cette ligne dans PowerShell.",
    copy: "Copier", copied: "Copié",
    notes: ["Il te faut Node.js et PowerShell 7. L'installateur propose de les installer pour toi.", "Chaque mise à jour est signée par l'éditeur d'Albus et vérifiée sur ton PC. Ton portefeuille et tes clés ne le quittent jamais.", "Le programme n'est pas encore signé, Windows peut donc afficher un avertissement. Lis le script avant si tu veux, il est court."]
  }
};
