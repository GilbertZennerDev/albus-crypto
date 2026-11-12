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

export const CMD_LINUX = "curl -fsSLO https://albus.workflowsolved.com/releases/install-farm.ps1 && sudo pwsh -File install-farm.ps1 -Address albus1DEINE_ADRESSE -Name Server-1";
export const CMD_WIN = "irm https://albus.workflowsolved.com/releases/install-farm.ps1 -OutFile install-farm.ps1; ./install-farm.ps1 -Address albus1DEINE_ADRESSE -Name Rig-1";

export const F = {
  de: {
    h: "Eigene Server und Farm",
    p: "Mehr Rechner, eine Wallet: Dein Server oder jeder weitere PC schürft für deine Adresse. Den privaten Schlüssel brauchen sie nicht, er bleibt auf deinem Haupt-PC. Alle Rechner erscheinen mit Name und Geschwindigkeit in der Miner-Oberfläche.",
    btn: "Farm-Skript herunterladen",
    steps: ["Kopiere deine Adresse (<code>albus1…</code>) aus der Miner-Oberfläche.", "Auf dem Server oder PC einen der beiden Befehle einfügen. Das ersetzt <code>albus1DEINE_ADRESSE</code> durch deine Adresse.", "Nach wenigen Sekunden erscheint der Rechner im Miner unter <i>Your farm and servers</i>."],
    linux: "Linux-Server (als root, mit PowerShell 7):",
    win: "Windows-PC (PowerShell 7 als Administrator):",
    copy: "Kopieren", copied: "Kopiert",
    notes: ["Auf jedem Rechner wird Node.js 20 oder neuer gebraucht. Linux: nur Prozessor (CPU), keine Grafikkarte.", "Der Rechner läuft danach als Dienst und startet nach jedem Neustart von selbst. Entfernen: dasselbe Skript mit <code>-Uninstall</code>."]
  },
  en: {
    h: "Your own servers and farm",
    p: "More computers, one wallet: your server or any extra PC mines for your address. They do not need the private key, it stays on your main PC. Every computer shows up with name and speed in the miner window.",
    btn: "Download the farm script",
    steps: ["Copy your address (<code>albus1…</code>) from the miner window.", "On the server or PC paste one of the two commands. Replace <code>albus1DEINE_ADRESSE</code> with your address.", "After a few seconds the computer appears in the miner under <i>Your farm and servers</i>."],
    linux: "Linux server (as root, with PowerShell 7):",
    win: "Windows PC (PowerShell 7 as administrator):",
    copy: "Copy", copied: "Copied",
    notes: ["Every computer needs Node.js 20 or newer. Linux: processor (CPU) only, no graphics card.", "The computer then runs as a service and starts by itself after every reboot. To remove it: run the same script with <code>-Uninstall</code>."]
  },
  fr: {
    h: "Tes propres serveurs et ta ferme",
    p: "Plus d'ordinateurs, un seul portefeuille : ton serveur ou chaque PC supplémentaire mine pour ton adresse. Ils n'ont pas besoin de la clé privée, elle reste sur ton PC principal. Chaque ordinateur apparaît avec son nom et sa vitesse dans la fenêtre du mineur.",
    btn: "Télécharger le script de ferme",
    steps: ["Copie ton adresse (<code>albus1…</code>) depuis la fenêtre du mineur.", "Sur le serveur ou le PC, colle l'une des deux commandes. Remplace <code>albus1DEINE_ADRESSE</code> par ton adresse.", "Après quelques secondes, l'ordinateur apparaît dans le mineur sous <i>Your farm and servers</i>."],
    linux: "Serveur Linux (en root, avec PowerShell 7) :",
    win: "PC Windows (PowerShell 7 en administrateur) :",
    copy: "Copier", copied: "Copié",
    notes: ["Chaque ordinateur a besoin de Node.js 20 ou plus récent. Linux : processeur (CPU) seulement, pas de carte graphique.", "L'ordinateur tourne ensuite comme service et redémarre tout seul. Pour le retirer : le même script avec <code>-Uninstall</code>."]
  }
};
