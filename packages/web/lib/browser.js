"use strict";
//TODO: To minimize dependencies I should just write this
const fs = require("fs-extra");

const url = require("url");
const puppeteer = require("puppeteer");
const { evalRuleSet } = require("@browselang/core");
const {
  resolveFn,
  resolveFnScope,
  resolveVar,
  resolveInternal,
  resolveInternalScope,
  validateScope,
} = require("@browselang/core/lib/scope");
const { help } = require("@browselang/core/lib/utils");
const UrlPattern = require("url-pattern");
const { BrowseError } = require("@browselang/core/lib/error");
const isDocker = require("is-docker");

const getPageScope = require("./page");

const newBrowser = async (headless) => {
  return await puppeteer.launch({
    ...(isDocker()
      ? {
          headless: false,
          args: [
            // Required for Docker version of Puppeteer
            "--no-sandbox",
            "--disable-setuid-sandbox",
            // This will write shared memory files into /tmp instead of /dev/shm,
            // because Docker’s default for /dev/shm is 64MB
            "--disable-dev-shm-usage",
          ],
        }
      : {
          headless,
        }),
  });
};
const throws = (fn) => (...args) => {
  try {
    return { success: true, value: fn(...args) };
  } catch (e) {
    return { success: false, err: e };
  }
};

const assertBrowserScope = (scope, message) => {
  if (!validateScope((scope) => scope.internal.isBrowser, scope)) {
    throw new Error(message);
  }
};

//Centralize control of goto function
const go = async (page, href) => {
  return page.goto(href, {
    timeout: 25000,
  });
};

const preparePage = (parent) => async (browser, href) => {
  const newPageScope = getPageScope(parent);

  //Give the new page scope a fresh tab
  const page = await browser.newPage();
  newPageScope.internal.page = page;

  //Navigate to the fresh page
  try {
    await go(page, href);
  } catch (e) {
    throw new BrowseError({
      message: `Failed to goto url ${href}`,
      node: null,
    });
  }
  return newPageScope;
};

/**
 * A scope containing all the web-scraping functions and variables
 */
const getBrowserScope = (parent) => ({
  parent,
  vars: {
    headless: true,
  },
  internal: {
    //To tell if we're in a browser scope
    isBrowser: true,
    // A single browser for now
    browser: null,
    // Page definitions
    pageDefs: {},
  },
  fns: {
    help: (scope) => (key) => {
      // Find the lowest scope that actually has the 'help' function
      const helpScope = resolveFnScope("help", scope);
      help({
        resolveFn,
        scope: helpScope,
        key,
        functions: {
          page:
            "Instantiates a page definition which matches on the url-pattern passed in as the first argument, and which executes the rule set passed in as the second argument on every matching page",
          visit:
            "Open a new tab/page with the given url and checks for matches on that URL. If there are matches the corresponding ruleSets will be run. If there is no match The new tab/page is opened in the browser scope and no actions will be taken",
        },
      });
      return null;
    },
    page: (scope) => (pattern, ...ruleSets) => {
      assertBrowserScope(scope, "Cannot call page outside of a Browser scope");
      const urlObj = url.parse(pattern);

      if (!urlObj || !urlObj.host) {
        throw new BrowseError({
          message: `'${pattern}' is not a valid URL pattern`,
          node: null,
        });
      }

      // validate that the path does not contain :url
      if (urlObj.pathname && /:(url|query|hash)/.test(urlObj.pathname)) {
        throw new BrowseError({
          message: `The pattern cannot contain :url, :query or :hash. $url, $query and $hash are automatically set when evaluating the page RuleSet`,
          node: null,
        });
      }

      let finalPattern = "http(s)\\://";
      finalPattern += urlObj.host;
      if (urlObj.port) {
        finalPattern += "\\:" + urlObj.port;
      }
      if (urlObj.pathname) {
        finalPattern += urlObj.pathname; // this can contain ":" which goes back into a new urlpattern
      }

      resolveInternal("pageDefs", scope)[finalPattern] = {
        matcher: new UrlPattern(finalPattern),
        ruleSets,
        parent: scope,
      };
      return null;
    },
    visit: (scope) => async (href) => {
      assertBrowserScope(scope, "Cannot call visit outside of a Browser scope");
      // Check if any pageDefs exist and execute them if found
      let match = null;
      try {
        resolveInternal("pageDefs", scope, (defs) => {
          if (match || !defs) return false; // match already found

          // TODO: Make this determinisitic
          for (const key in defs) {
            const { matcher, ruleSets, parent } = defs[key];
            const matchObj = matcher.match(href.split("?")[0]);
            if (matchObj) {
              const urlObj = url.parse(href);
              match = {
                parent,
                ruleSets,
                path: matchObj,
                query: urlObj.query || null,
                hash: urlObj.hash || null,
              };
            }
          }
          return !!match;
        });
      } catch (e) {}

      //Get the nearest browser scope
      const nearestBrowserScope = resolveInternalScope("browser", scope);

      const isHeadless = resolveVar("headless", scope);

      //If the nearest browser scope doesn't have a browser, create one
      let browser = nearestBrowserScope.internal.browser;
      if (!browser) {
        browser = nearestBrowserScope.internal.browser = await newBrowser(
          isHeadless
        );
      }

      if (match) {
        await Promise.all(
          match.ruleSets.map(async (ruleSet) => {
            //Create a new page scope in the same scope that the page rule was created in and navigate to href
            const newPageScope = await preparePage(match.parent)(browser, href);

            // inject args and "url" as variables into the new page scope
            Object.assign(newPageScope.vars, match.path, {
              url: href,
              hash: match.hash,
              query: match.query,
            });

            await evalRuleSet(ruleSet, newPageScope);

            // TODO: check if the url has changed? If so, recurse and execute the necessary `page` rule
            const data = newPageScope.internal.data;
            if (Object.keys(data).length) {
              if (data.url) {
                console.warn(
                  "WARNING:: The key 'url' will always be overridden by the default url value (See docs <https://....>)"
                );
              }
              data.url = href;
              //Grabs the nearest config where output is defined, else return false
              const { value: config, success } = throws(resolveInternal)(
                "config",
                newPageScope,
                (config) => !!config.output
              );

              if (success) {
                if (config.writeStream) {
                  config.writeStream.write(JSON.stringify(data) + "\n", {
                    flags: "a",
                  });
                  config.writeStream.end("");
                } else {
                  fs.ensureFileSync(config.output);
                  config.writeStream = fs.createWriteStream(config.output);
                }
              } else {
                console.log(JSON.stringify(data));
              }
            }
            // Finally, close the page
            newPageScope.internal.page.close();
          })
        );
      } else {
        //Create a new page in the nearest browser scope and navigate to href
        await preparePage(nearestBrowserScope)(browser, href);
      }
      return href;
    },
  },
});

module.exports = getBrowserScope;
