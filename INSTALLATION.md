# Energy Topology — Guide d'installation (v0.1.0)

Ce document explique comment installer la première version de **Energy Topology**
dans Home Assistant.

## Prérequis

- Home Assistant 2025.4.0 ou plus récent
- HACS (recommandé) ou installation manuelle
- Dashboard Énergie configuré
- Au moins un appareil individuel déclaré

## Installation manuelle

Décompressez l'archive du projet, puis copiez le dossier :

```text
custom_components/energy_topology/
```

dans :

```text
/config/custom_components/
```

Vous devez obtenir :

```text
/config/custom_components/
└── energy_topology/
    ├── __init__.py
    ├── manifest.json
    ├── config_flow.py
    ├── const.py
    ├── strings.json
    ├── frontend/
    └── translations/
```

## Redémarrage

Redémarrez Home Assistant.

## Ajout de l'intégration

Ouvrez **Réglages → Appareils et services → Ajouter une intégration**, recherchez
**Energy Topology**, puis validez.

## Première utilisation

Après installation, un panneau **Topologie énergie** apparaît dans la barre
latérale. La version actuelle est **100 % lecture seule** : aucune modification
n'est appliquée au Dashboard Énergie.

## Fonctionnalités disponibles (v0.1.0)

- lecture des appareils individuels
- lecture des relations upstream (`included_in_stat`)
- construction de l'arbre
- recherche par nom ou `statistic_id`
- détection des parents absents
- détection des cycles
- détection des auto-références

## Dépannage

**L'intégration n'apparaît pas :** vérifiez le dossier `custom_components`,
vérifiez `manifest.json`, redémarrez Home Assistant.

**Aucun appareil affiché :** vérifiez que le Dashboard Énergie contient des
**Appareils individuels**.

## Support

Projet en développement. Les retours, captures d'écran et journaux d'erreur
aident à améliorer la compatibilité :
<https://github.com/tazelbaze/ha-energy-topology/issues>.
