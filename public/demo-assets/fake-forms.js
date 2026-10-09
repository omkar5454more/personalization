/* Stand-in for a third-party form provider (like HubSpot's hbspt.forms.create), used to test that
 * Optimize loads an external <script> first and only then runs the campaign's JavaScript tab.
 * On submit it posts the same window message HubSpot does, so conversion tracking can be verified. */
window.fakeforms = {
  create: function (opts) {
    var target = document.querySelector(opts.target);
    if (!target) { throw new Error("fakeforms: target " + opts.target + " not found"); }
    target.innerHTML =
      '<form class="ff"><label>Work email <input type="email" name="email" required></label>' +
      '<label>Company <input type="text" name="company"></label>' +
      '<button type="submit">' + (opts.button || "Submit") + '</button></form>';
    target.querySelector("form").addEventListener("submit", function (e) {
      e.preventDefault();
      target.innerHTML = "<p><b>" + (opts.thanks || "Thanks!") + "</b></p>";
      window.postMessage({ type: "hsFormCallback", eventName: "onFormSubmitted" }, "*");
    });
  }
};
