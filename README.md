# Ready Hawke's Bay

A phone-friendly web app that helps people in Hawke's Bay, New Zealand, get ready for emergencies.

- **My place:** type an address (or use your location) to check it against the official tsunami evacuation zone and get a walking route to the nearest point outside it.
- **Pack:** set your household (adults, children, babies, older people, pets) and get grab bag, stay-at-home and car kit lists with quantities.
- **Practice:** time how long your household takes to get out the door and walk to safety, against the 15 minute local tsunami window.
- **Emergency now:** step-by-step actions for earthquake and tsunami, flood, armed attack, and outages.

This is a prototype. In a real emergency, follow Civil Defence and emergency services.

## How the route works

1. The zone is loaded from Hawke's Bay Regional Council's `HawkesBay_Tsunami_Evacuation_Zones_View` layer (CC BY 4.0).
2. If the start point is inside the zone, the app picks up to 20 points just outside the zone boundary (including "islands" of high ground inside it), nearest first.
3. It asks the OSRM walking router for the time to each, drops any that snap back inside the zone, and routes to the quickest.

## Data and services

| What | Source | Licence / terms |
| --- | --- | --- |
| Tsunami evacuation zone | Hawke's Bay Regional Council / HB Emergency Management | CC BY 4.0 |
| Address search | Nominatim (OpenStreetMap) | [Usage policy](https://operations.osmfoundation.org/policies/nominatim/) |
| Walking routes | FOSSGIS OSRM (routing.openstreetmap.de) | [Usage policy](https://routing.openstreetmap.de/about.html) |
| Map tiles | OpenStreetMap | [Tile policy](https://operations.osmfoundation.org/policies/tiles/) |

The public search, routing and tile services are fine for a prototype but not for heavy use; a public launch should use a paid or self-hosted service.

## Run it

It is a static site with no build step. Open `index.html` in a browser, or serve the folder with any static host (for example GitHub Pages).
