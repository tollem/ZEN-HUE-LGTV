'use strict';
const Service = require('webos-service');
const {createBackend} = require('./bridge');
const service = new Service('com.samuel.huetv.service');
const backend = createBackend();
const allowedSender = 'com.samuel.huetv';
for (const name of ['status','pair','snapshot','setLight','beginPreview','cancelPreview','setRoom','activateScene','saveScene','automations','setAutomation']) {
  service.register(name, function(message) {
    if (message.sender !== allowedSender) {
      message.respond({returnValue:false,error:'Appel non autorisé.'});
      return;
    }
    Promise.resolve().then(()=>backend[name](message.payload||{})).then(result=>message.respond(result)).catch(err=>{
      // No bridge payloads, credentials or request details in logs or responses.
      const allowed = new Set(['Appuie sur le bouton du pont, puis réessaie.','Stockage local privé indisponible.','Association créée mais stockage et révocation non confirmés.','Pont non associé.','Adresse locale invalide.','Ce n’est pas le pont Hue attendu.','Association refusée par le pont.','Connexion sécurisée au pont Hue impossible.','Le pont Hue ne répond pas.','Pièce introuvable.','Identifiant invalide.','Luminosité invalide.','État invalide.','Commande vide.','Le pont Hue a refusé la demande.']);
      for (const value of ['Lampe introuvable.','Automatisation introuvable.','Couleur invalide.','Température invalide.','Choisis une couleur ou une température.','Cette lampe ne prend pas en charge les couleurs.','Cette lampe ne prend pas en charge le blanc réglable.','Température hors plage de cette lampe.','Règle la couleur lampe par lampe.']) allowed.add(value);
      for (const value of ['Le nom doit contenir entre 1 et 32 caractères.','La composition de la pièce est indisponible.','L’état complet des lampes est indisponible.','Impossible d’enregistrer : une lampe est injoignable ou son état est inconnu.','Aucune lampe à enregistrer dans cette pièce.','Un effet animé ou un dégradé ne peut pas être enregistré comme ambiance statique.','L’état complet des couleurs est indisponible.','Création non confirmée. Vérifie la liste des ambiances.']) allowed.add(value);
      allowed.add('Commande envoyée, résultat non confirmé. Actualise avant de réessayer.');
      for (const value of ['État initial de la lampe indisponible.','Lampe injoignable ou état inconnu.','Aperçu indisponible pendant un effet animé ou un dégradé.','État initial de la couleur indisponible.','Restauration non confirmée. Réessaie.']) allowed.add(value);
      const text = err && allowed.has(err.message) ? err.message : 'Impossible de communiquer avec le pont Hue.';
      message.respond({returnValue:false,error:text});
    });
  });
}
