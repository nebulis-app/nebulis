// ----------------------------------------------------------------------------
// Nebulis Astrophotography Connector for PixInsight
// ----------------------------------------------------------------------------
// File: NebulisConnector.js
// Description: Official PixInsight JavaScript Runtime (PJSR) connector for Nebulis.
//              Provides deep two-way integration between PixInsight and self-hosted
//              Nebulis observatories:
//              1. Catalog & Session Browser: Live search and inspection of imaged DSOs.
//              2. Smart Calibration Auto-Matcher: Automatic scoring and selection of
//                 compatible Master Darks, Flats, Bias, and Flat-Darks from Nebulis.
//              3. WBPP Workspace Generator: Automated download and organization of
//                 light subframes and calibration masters ready for preprocessing.
//              4. Project & Icon Sync: Exporting active workspace process icons (.xpsm)
//                 and project archives directly to object processing directories.
//
// Compatibility: PixInsight >= 1.8.9 and PixInsight 1.9.x (macOS, Linux, Windows)
// Author: Nebulis Team
// License: MIT
// ----------------------------------------------------------------------------

#engine v8

#feature-id    NebulisConnector : Nebulis > Nebulis Connector
#feature-info  Nebulis Astrophotography Connector for PixInsight. Browse objects, download sessions, auto-match calibration frames (darks, flats, bias), and sync your PixInsight processing projects to Nebulis.

#include <pjsr/FrameStyle.jsh>
#include <pjsr/TextAlign.jsh>
#include <pjsr/StdIcon.jsh>
#include <pjsr/StdButton.jsh>
#include <pjsr/DataType.jsh>

var DT_Boolean = (typeof DataType_Boolean !== "undefined") ? DataType_Boolean : 0;
var DT_Double = (typeof DataType_Double !== "undefined") ? DataType_Double : 10;
var DT_String = (typeof DataType_String !== "undefined") ? DataType_String : 13;
var DT_ByteArray = (typeof DataType_ByteArray !== "undefined") ? DataType_ByteArray : 14;

var NEBULIS_VERSION = "2.1.0";
var SETTINGS_MODULE = "Nebulis";

function processUIMessages() {
   if (typeof CoreApplication !== "undefined" && typeof CoreApplication.processEvents === "function") {
      CoreApplication.processEvents();
   } else if (typeof processEvents === "function") {
      processEvents();
   }
}

function sleepMs(ms) {
   if (typeof System !== "undefined" && typeof System.msleep === "function") {
      System.msleep(ms);
   } else if (typeof msleep === "function") {
      msleep(ms);
   }
}

function getFileSize(filePath) {
   try {
      if (typeof FileInfo !== "undefined") {
         var fi = new FileInfo(filePath);
         if (typeof fi.size === "number") return fi.size;
      }
      if (typeof File !== "undefined" && File.exists(filePath)) {
         var f = new File;
         f.openForReading(filePath);
         var s = f.size;
         f.close();
         return s;
      }
   } catch (e) {}
   return 0;
}

// ----------------------------------------------------------------------------
// NetworkTransfer PJSR Compatibility Helpers
// ----------------------------------------------------------------------------
function configureNetworkTransfer(transfer, url, headers) {
   // 1. In PJSR, setURL *must* be called before setCustomHTTPHeaders because setURL resets headers
   if (typeof transfer.setURL === "function") {
      transfer.setURL(url);
   } else if (typeof transfer.SetURL === "function") {
      transfer.SetURL(url);
   }

   // 2. SSL
   var isHttps = url.indexOf("https://") === 0;
   if (typeof transfer.setSSL === "function") {
      transfer.setSSL(isHttps);
   } else if (typeof transfer.SetSSL === "function") {
      transfer.SetSSL(isHttps);
   }

   // 3. Connection Timeout (seconds)
   if (typeof transfer.setConnectionTimeout === "function") {
      try { transfer.setConnectionTimeout(30); } catch (e) {}
   }

   // 4. Custom HTTP Headers
   // PJSR expects an Array of Strings (an Object reference). If that fails, try string or bypass.
   if (headers && headers.length > 0) {
      var headerArr = Array.isArray(headers) ? headers : [headers];
      try {
         if (typeof transfer.setCustomHTTPHeaders === "function") {
            transfer.setCustomHTTPHeaders(headerArr);
         } else if (typeof transfer.SetCustomHTTPHeaders === "function") {
            transfer.SetCustomHTTPHeaders(headerArr);
         }
      } catch (hErr) {
         try {
            var headerStr = headerArr.join("\n");
            if (typeof transfer.setCustomHTTPHeaders === "function") {
               transfer.setCustomHTTPHeaders(headerStr);
            }
         } catch (e2) {
            console.writeln("[Nebulis] Notice: custom HTTP headers bypassed: " + hErr.message);
         }
      }
   }
}

function executeDownload(transfer) {
   if (typeof transfer.download === "function") return transfer.download();
   if (typeof transfer.Download === "function") return transfer.Download();
   return false;
}

function executePost(transfer, postBody) {
   if (typeof transfer.post === "function") return transfer.post(postBody || "");
   if (typeof transfer.POST === "function") return transfer.POST(postBody || "");
   return false;
}

function getTransferResponseCode(transfer) {
   if (transfer.responseCode !== undefined) return transfer.responseCode;
   if (transfer.ResponseCode !== undefined) return transfer.ResponseCode;
   return 0;
}

function getTransferErrorInfo(transfer) {
   if (transfer.errorInformation !== undefined) return transfer.errorInformation;
   if (transfer.ErrorInformation !== undefined) return transfer.ErrorInformation;
   return "";
}

// ----------------------------------------------------------------------------
// Configuration & Settings Persistence
// ----------------------------------------------------------------------------

/**
 * Manages configuration properties and persistence in PixInsight's application registry.
 *
 * Persists user options across PixInsight restarts using `Settings.read` and
 * `Settings.write` under the `Nebulis/` registry namespace.
 *
 * @constructor
 */
function NebulisSettings() {
   this.serverUrl = "http://localhost:3002";
   this.apiKey = "";
   this.downloadDir = (typeof File !== "undefined" && File.homeDirectory) ? 
                      File.homeDirectory + "/AstroProjects" : "./AstroProjects";
   this.useDedicatedCalibrationsDir = false;
   this.calibrationsDir = (typeof File !== "undefined" && File.homeDirectory) ? 
                          File.homeDirectory + "/AstroProjects/Calibrations" : "./AstroProjects/Calibrations";
   this.lightsSubfolder = "lights";
   this.calibrationsSubfolder = "calibrations";
   this.projectSubfolder = "processing_project";
   this.autoMatchCalibrations = true;
   this.tempTolerance = 2.0;    // degrees Celsius
   this.expTolerance = 0.15;    // 15% relative or 1s absolute
   this.organizeSubfolders = true;
   this.fastDownloadMode = true; // Use ExternalProcess (curl/powershell) if available

   this.getResolvedWorkspaceDir = function(objectName) {
      var cleanName = (objectName || "target").replace(/[^a-zA-Z0-9_\-]/g, "_");
      var base = this.downloadDir.replace(/\/+$/, "");
      return base + "/" + cleanName;
   };

   this.getResolvedLightsDir = function(objectName) {
      return this.getResolvedWorkspaceDir(objectName) + "/" + (this.lightsSubfolder || "lights");
   };

   this.getResolvedCalibrationsDir = function(objectName) {
      if (this.useDedicatedCalibrationsDir && this.calibrationsDir && this.calibrationsDir.trim().length > 0) {
         return this.calibrationsDir.replace(/\/+$/, "");
      }
      return this.getResolvedWorkspaceDir(objectName) + "/" + (this.calibrationsSubfolder || "calibrations");
   };

   this.getResolvedProjectDir = function(objectName) {
      return this.getResolvedWorkspaceDir(objectName) + "/" + (this.projectSubfolder || "processing_project");
   };

   this.load = function() {
      try {
         if (typeof Settings !== "undefined") {
            var url = Settings.read(SETTINGS_MODULE + "/ServerUrl", DT_String);
            if (url) this.serverUrl = url;

            var key = Settings.read(SETTINGS_MODULE + "/ApiKey", DT_String);
            if (key) this.apiKey = key;

            var dir = Settings.read(SETTINGS_MODULE + "/DownloadDir", DT_String);
            if (dir) this.downloadDir = dir;

            var useDed = Settings.read(SETTINGS_MODULE + "/UseDedicatedCalibrationsDir", DT_Boolean);
            if (typeof useDed === "boolean") this.useDedicatedCalibrationsDir = useDed;

            var cDir = Settings.read(SETTINGS_MODULE + "/CalibrationsDir", DT_String);
            if (cDir) this.calibrationsDir = cDir;

            var lSub = Settings.read(SETTINGS_MODULE + "/LightsSubfolder", DT_String);
            if (lSub) this.lightsSubfolder = lSub;

            var cSub = Settings.read(SETTINGS_MODULE + "/CalibrationsSubfolder", DT_String);
            if (cSub) this.calibrationsSubfolder = cSub;

            var pSub = Settings.read(SETTINGS_MODULE + "/ProjectSubfolder", DT_String);
            if (pSub) this.projectSubfolder = pSub;

            var auto = Settings.read(SETTINGS_MODULE + "/AutoMatchCalibrations", DT_Boolean);
            if (typeof auto === "boolean") this.autoMatchCalibrations = auto;

            var tempTol = Settings.read(SETTINGS_MODULE + "/TempTolerance", DT_Double);
            if (typeof tempTol === "number" && !isNaN(tempTol)) this.tempTolerance = tempTol;

            var expTol = Settings.read(SETTINGS_MODULE + "/ExpTolerance", DT_Double);
            if (typeof expTol === "number" && !isNaN(expTol)) this.expTolerance = expTol;

            var org = Settings.read(SETTINGS_MODULE + "/OrganizeSubfolders", DT_Boolean);
            if (typeof org === "boolean") this.organizeSubfolders = org;

            var fast = Settings.read(SETTINGS_MODULE + "/FastDownloadMode", DT_Boolean);
            if (typeof fast === "boolean") this.fastDownloadMode = fast;
         }
      } catch (e) {
         console.writeln("[Nebulis] Warning reading settings: " + e.message);
      }
   };

   this.save = function() {
      try {
         if (typeof Settings !== "undefined") {
            Settings.write(SETTINGS_MODULE + "/ServerUrl", DT_String, this.serverUrl);
            Settings.write(SETTINGS_MODULE + "/ApiKey", DT_String, this.apiKey);
            Settings.write(SETTINGS_MODULE + "/DownloadDir", DT_String, this.downloadDir);
            Settings.write(SETTINGS_MODULE + "/UseDedicatedCalibrationsDir", DT_Boolean, this.useDedicatedCalibrationsDir);
            Settings.write(SETTINGS_MODULE + "/CalibrationsDir", DT_String, this.calibrationsDir);
            Settings.write(SETTINGS_MODULE + "/LightsSubfolder", DT_String, this.lightsSubfolder);
            Settings.write(SETTINGS_MODULE + "/CalibrationsSubfolder", DT_String, this.calibrationsSubfolder);
            Settings.write(SETTINGS_MODULE + "/ProjectSubfolder", DT_String, this.projectSubfolder);
            Settings.write(SETTINGS_MODULE + "/AutoMatchCalibrations", DT_Boolean, this.autoMatchCalibrations);
            Settings.write(SETTINGS_MODULE + "/TempTolerance", DT_Double, this.tempTolerance);
            Settings.write(SETTINGS_MODULE + "/ExpTolerance", DT_Double, this.expTolerance);
            Settings.write(SETTINGS_MODULE + "/OrganizeSubfolders", DT_Boolean, this.organizeSubfolders);
            Settings.write(SETTINGS_MODULE + "/FastDownloadMode", DT_Boolean, this.fastDownloadMode);
         }
      } catch (e) {
         console.writeln("[Nebulis] Warning saving settings: " + e.message);
      }
   };
}

var nebulisConfig = new NebulisSettings();
nebulisConfig.load();

// ----------------------------------------------------------------------------
// Nebulis HTTP API Client
// ----------------------------------------------------------------------------

/**
 * Handles HTTP/REST communication with the Nebulis backend server.
 *
 * Implements synchronous network transfers using PixInsight's native `NetworkTransfer`
 * class with automatic header injection (including `X-API-Key` authentication),
 * JSON response parsing, and high-performance binary file streaming with `ExternalProcess`
 * curl acceleration when available.
 *
 * @param {NebulisSettings} config - Active settings configuration instance.
 * @constructor
 */
function NebulisClient(config) {
   this.config = config;

   this.normalizeBaseUrl = function() {
      var url = this.config.serverUrl || "http://localhost:3002";
      return url.replace(/\/+$/, "");
   };

   this.getHeaders = function() {
      var headers = new Array();
      headers.push("Accept: application/json");
      if (this.config.apiKey && this.config.apiKey.trim().length > 0) {
         var k = this.config.apiKey.trim();
         headers.push("X-API-Key: " + k);
         headers.push("Authorization: Bearer " + k);
      } else if (this.config.authToken && this.config.authToken.trim().length > 0) {
         headers.push("Authorization: Bearer " + this.config.authToken.trim());
      }
      return headers;
   };

   /**
    * Authenticates against Nebulis server using username and password.
    */
   this.login = function(username, password) {
      var res = this.request("POST", "/api/v1/auth/login", {
         username: username,
         password: password
      });
      if (!res.ok) {
         throw new Error(res.error || "Login failed");
      }
      var token = (res.data && res.data.token) ? res.data.token : null;
      if (token) {
         this.config.authToken = token;
         this.config.save();
         return { ok: true, user: res.data.user || { username: username } };
      }
      throw new Error("No authorization token received from server");
   };

   /**
    * Executes an HTTP request via system curl using ExternalProcess when available.
    * Guarantees custom headers (such as X-API-Key and Authorization) pass cleanly.
    */
   this.requestViaCurl = function(method, endpoint, body) {
      if (typeof ExternalProcess === "undefined") return null;
      try {
         var fullUrl = this.normalizeBaseUrl() + endpoint;
         var tmpDir = (typeof File !== "undefined" && File.systemTempDirectory) ? File.systemTempDirectory : "/tmp";
         var tmpFile = tmpDir + "/neb_api_" + Date.now() + "_" + Math.floor(Math.random() * 100000) + ".json";

         var curlArgs = ["-s", "-L", fullUrl, "-o", tmpFile];
         curlArgs.push("-H", "Accept: application/json");

         var apiKey = (this.config.apiKey && this.config.apiKey.trim().length > 0) ? this.config.apiKey.trim() : "";
         var authToken = (this.config.authToken && this.config.authToken.trim().length > 0) ? this.config.authToken.trim() : "";

         if (apiKey) {
            curlArgs.push("-H", "X-API-Key: " + apiKey);
            curlArgs.push("-H", "Authorization: Bearer " + apiKey);
         } else if (authToken) {
            curlArgs.push("-H", "Authorization: Bearer " + authToken);
         }

         if (method.toUpperCase() === "POST" && body) {
            curlArgs.push("-H", "Content-Type: application/json");
            var bodyStr = typeof body === "string" ? body : JSON.stringify(body);
            curlArgs.push("-d", bodyStr);
         }

         var proc = new ExternalProcess;
         if (proc.start("curl", curlArgs)) {
            while (proc.isStarting) {
               processUIMessages();
            }
            while (proc.isRunning) {
               processUIMessages();
               sleepMs(10);
            }
            if (File.exists(tmpFile)) {
               var f = new File;
               f.openForReading(tmpFile);
               var rawText = "";
               if (f.size > 0) {
                  var rawBytes = f.read(DT_ByteArray, f.size);
                  if (typeof rawBytes.utf8ToString === "function") {
                     rawText = rawBytes.utf8ToString();
                  } else {
                     rawText = rawBytes.toString();
                  }
               }
               f.close();
               File.remove(tmpFile);

               if (rawText.length > 0) {
                  try {
                     var parsed = JSON.parse(rawText);
                     if (parsed && typeof parsed.ok === "boolean") {
                        if (parsed.ok) {
                           return { ok: true, data: parsed.data !== undefined ? parsed.data : parsed, statusCode: 200 };
                        } else {
                           var errMsg = (parsed.error && parsed.error.message) ? parsed.error.message : (parsed.error || "API error");
                           var isAuthErr = parsed.error && (parsed.error.code === "AUTH_REQUIRED" || parsed.error.code === "UNAUTHORIZED");
                           return { ok: false, error: errMsg, statusCode: isAuthErr ? 401 : 400 };
                        }
                     }
                     return { ok: true, data: parsed, statusCode: 200 };
                  } catch (parseErr) {
                     return { ok: true, data: rawText, raw: rawText, statusCode: 200 };
                  }
               }
            }
         }
      } catch (err) {
         // curl execution failed, fall back to native NetworkTransfer
      }
      return null;
   };

   /**
    * Performs a synchronous HTTP request via curl accelerator or PixInsight NetworkTransfer
    */
   this.request = function(method, endpoint, body) {
      // 1. Try system curl accelerator first (robust multi-platform header support)
      var curlRes = this.requestViaCurl(method, endpoint, body);
      if (curlRes !== null) {
         return curlRes;
      }

      // 2. Native PJSR NetworkTransfer fallback
      var fullUrl = this.normalizeBaseUrl() + endpoint;
      var headers = this.getHeaders();

      if (typeof NetworkTransfer === "undefined") {
         return { ok: false, error: "PJSR NetworkTransfer class is unavailable in this environment." };
      }

      var transfer = new NetworkTransfer;
      configureNetworkTransfer(transfer, fullUrl, headers);

      var responseData = new ByteArray;
      transfer.onDownloadDataAvailable = function(chunk) {
         if (typeof responseData.add === "function") {
            responseData.add(chunk);
         } else if (typeof responseData.append === "function") {
            responseData.append(chunk);
         }
         return true;
      };

      var success = false;
      var postDataStr = "";

      if (method.toUpperCase() === "POST") {
         headers.push("Content-Type: application/json");
         configureNetworkTransfer(transfer, fullUrl, headers);

         if (body) {
            postDataStr = (typeof body === "string") ? body : JSON.stringify(body);
         }
         success = executePost(transfer, postDataStr);
      } else {
         success = executeDownload(transfer);
      }

      var statusCode = getTransferResponseCode(transfer);
      var responseText = "";
      if (responseData.length > 0) {
         try {
            if (typeof responseData.utf8ToString === "function") {
               responseText = responseData.utf8ToString();
            } else {
               responseText = responseData.toString();
            }
         } catch (e) {
            responseText = "";
         }
      }

      if (typeof transfer.closeConnection === "function") {
         try { transfer.closeConnection(); } catch (e) {}
      }

      if (!success && statusCode === 0) {
         return {
            ok: false,
            error: "Failed to connect to Nebulis server at " + fullUrl + " (" + getTransferErrorInfo(transfer) + ")",
            statusCode: 0
         };
      }

      var parsedJson = null;
      try {
         parsedJson = JSON.parse(responseText);
      } catch (parseErr) {
         // Non-JSON response
      }

      if (statusCode === 401) {
         var errMsg = (parsedJson && parsedJson.error && parsedJson.error.message) ?
                      parsedJson.error.message : "Authentication required";
         return {
            ok: false,
            error: errMsg + ". Please sign in or configure your API Key in Settings & Connection.",
            statusCode: 401
         };
      }

      var parsedJson = null;
      try {
         parsedJson = JSON.parse(responseText);
      } catch (parseErr) {
         // Non-JSON response
      }

      if (statusCode >= 200 && statusCode < 300) {
         if (parsedJson && typeof parsedJson.ok === "boolean") {
            if (parsedJson.ok) {
               return { ok: true, data: parsedJson.data !== undefined ? parsedJson.data : parsedJson };
            } else {
               return { ok: false, error: parsedJson.error || ("API error (code " + statusCode + ")") };
            }
         }
         return { ok: true, data: parsedJson || responseText, raw: responseText };
      }

      var errMsg = (parsedJson && (parsedJson.error || parsedJson.message)) ||
                   ("HTTP error " + statusCode + " from " + fullUrl);
      return { ok: false, error: errMsg, statusCode: statusCode };
   };

   this.testConnection = function() {
      // Try objects endpoint or system endpoints
      var res = this.request("GET", "/api/v1/library/objects?limit=1");
      if (res.ok) {
         return { ok: true, message: "Connected successfully to Nebulis API!", statusCode: 200 };
      }
      return { ok: false, message: res.error || "Connection failed", statusCode: res.statusCode !== undefined ? res.statusCode : 0 };
   };

   this.fetchObjects = function() {
      var res = this.request("GET", "/api/v1/library/objects");
      if (!res.ok) throw new Error(res.error || "Failed to fetch objects");
      var objects = res.data;
      if (objects && objects.items) return objects.items;
      if (Array.isArray(objects)) return objects;
      return [];
   };

   this.fetchSessions = function(objectId) {
      var res = this.request("GET", "/api/v1/library/objects/" + encodeURIComponent(objectId) + "/sessions");
      if (!res.ok) throw new Error(res.error || "Failed to fetch sessions");
      var sessions = res.data;
      if (sessions && sessions.items) return sessions.items;
      if (Array.isArray(sessions)) return sessions;
      return [];
   };

   this.fetchFiles = function(objectId) {
      var res = this.request("GET", "/api/v1/library/objects/" + encodeURIComponent(objectId) + "/files");
      if (!res.ok) return [];
      return res.data || [];
   };

   this.fetchCalibrations = function() {
      var res = this.request("GET", "/api/v1/library/calibrations");
      if (!res.ok || !res.data) return [];
      var groups = res.data.groups || res.data.items || (Array.isArray(res.data) ? res.data : []);
      var flatList = [];

      for (var i = 0; i < groups.length; ++i) {
         var grp = groups[i];
         var type = grp.type || grp.frameType || "calibration";
         var typeLabel = grp.typeLabel || (type.charAt(0).toUpperCase() + type.slice(1));
         var scope = grp.scope || null;
         var scopeLabel = grp.scopeLabel || (scope ? "Scope " + scope.slice(0, 8) : "Default Rig");
         var folderName = grp.folderName || "";

         if (grp.settingsGroups && Array.isArray(grp.settingsGroups) && grp.settingsGroups.length > 0) {
            for (var s = 0; s < grp.settingsGroups.length; ++s) {
               var sg = grp.settingsGroups[s];
               var exp = (sg.exposureSec !== undefined) ? sg.exposureSec : (sg.exposure || 0);
               var gain = (sg.gain !== undefined) ? sg.gain : null;
               var bin = sg.binning ? String(sg.binning) : "1";
               var temp = (sg.sensorTempC !== undefined) ? sg.sensorTempC : null;
               var files = sg.files || [];
               var firstFilter = (files.length > 0 && files[0].info && files[0].info.filterLabel) ? files[0].info.filterLabel : "";
               var totalBytes = sg.bytes || 0;
               if (!totalBytes && files.length > 0) {
                  for (var fi = 0; fi < files.length; ++fi) totalBytes += (files[fi].size || 0);
               }

               var attachments = sg.attachments || [];
               var linkedStr = "—";
               if (attachments.length > 0) {
                  var links = [];
                  for (var a = 0; a < attachments.length; ++a) {
                     var att = attachments[a];
                     var nameStr = att.objectName || att.objectId || "Target";
                     if (att.date) nameStr += " (" + att.date + ")";
                     links.push(nameStr);
                  }
                  linkedStr = links.join(", ");
               }

               flatList.push({
                  frameType: type,
                  typeLabel: typeLabel,
                  scope: scope,
                  scopeLabel: scopeLabel,
                  folderName: folderName,
                  key: sg.key,
                  groupKey: (scope || "all") + "::" + folderName + "::" + sg.key,
                  name: typeLabel + " (" + scopeLabel + " - " + exp + "s, bin " + bin + ", gain " + (gain !== null ? gain : "any") + (temp !== null ? (", " + temp + "°C") : "") + ")",
                  exposure: exp,
                  exposureSec: exp,
                  gain: gain,
                  binning: bin,
                  sensorTempC: temp,
                  filter: firstFilter,
                  fileCount: sg.fileCount || files.length,
                  bytes: totalBytes,
                  files: files,
                  camera: scopeLabel,
                  linkedObject: linkedStr,
                  attachments: attachments,
                  isExpired: sg.isExpired || false
               });
            }
         } else {
            flatList.push(grp);
         }
      }
      return flatList;
   };

   this.fetchObjectCalibrations = function(objectId) {
      var res = this.request("GET", "/api/v1/library/calibrations/attachments?objectId=" + encodeURIComponent(objectId));
      if (!res.ok || !res.data) return [];
      if (Array.isArray(res.data.attachments)) return res.data.attachments;
      if (Array.isArray(res.data)) return res.data;
      return [];
   };

   this.requestCalibrationDownloadLink = function(scope, folderName, key) {
      var body = {
         scope: (scope !== undefined && scope !== null) ? String(scope) : null,
         folderName: String(folderName || ""),
         key: String(key || "")
      };
      var res = this.request("POST", "/api/v1/library/calibrations/download/link", body);
      if (!res.ok) throw new Error(res.error || "Failed to request calibration bundle");
      return res.data; // { url: "/api/v1/library/calibrations/download/...", filename: "...", expiresInMs: ... }
   };

   this.fetchProcessingProjectSummary = function(objectId) {
      var res = this.request("GET", "/api/v1/library/objects/" + encodeURIComponent(objectId) + "/processing-project");
      if (!res.ok) return { exists: false, files: [] };
      return res.data || { exists: false, files: [] };
   };

   this.saveProjectFile = function(objectId, relativePath, contentBase64OrText) {
      var body = {
         relativePath: relativePath,
         content: contentBase64OrText,
         isBase64: true
      };
      var res = this.request("POST", "/api/v1/library/objects/" + encodeURIComponent(objectId) + "/processing-project/file", body);
      if (!res.ok) throw new Error(res.error || "Failed to save project file");
      return res.data;
   };

   /**
    * Download a binary file directly to local disk
    */
   this.downloadFileToDisk = function(endpointOrUrl, targetPath, onProgress) {
      var fullUrl = endpointOrUrl.indexOf("http") === 0 ? endpointOrUrl : (this.normalizeBaseUrl() + endpointOrUrl);
      var dir = File.extractDrive(targetPath) + File.extractDirectory(targetPath);
      if (!File.directoryExists(dir)) {
         File.createDirectory(dir, true);
      }

      // If fast download mode enabled and curl available via ExternalProcess
      if (this.config.fastDownloadMode && typeof ExternalProcess !== "undefined") {
         try {
            var curlArgs = ["-s", "-L", fullUrl, "-o", targetPath];
            if (this.config.apiKey) {
               curlArgs.push("-H", "X-API-Key: " + this.config.apiKey.trim());
               curlArgs.push("-H", "Authorization: Bearer " + this.config.apiKey.trim());
            }
            var proc = new ExternalProcess;
            if (proc.start("curl", curlArgs)) {
               while (proc.isStarting) {
                  processUIMessages();
               }
               while (proc.isRunning) {
                  processUIMessages();
                  sleepMs(100);
               }
               if (proc.exitCode === 0 && File.exists(targetPath)) {
                  return true;
               }
            }
         } catch (e) {
            // Fall back to PJSR NetworkTransfer
         }
      }

      // Native PJSR NetworkTransfer download
      var transfer = new NetworkTransfer;
      configureNetworkTransfer(transfer, fullUrl, this.getHeaders());

      var outFile = new File;
      outFile.createForWriting(targetPath);

      var totalBytes = 0;
      transfer.onDownloadDataAvailable = function(chunk) {
         if (chunk.length > 0) {
            outFile.write(chunk);
            totalBytes += chunk.length;
            if (onProgress) onProgress(totalBytes);
         }
         return true;
      };

      var ok = executeDownload(transfer);
      outFile.close();

      var statusCode = getTransferResponseCode(transfer);
      if (!ok || statusCode >= 400) {
         if (File.exists(targetPath)) File.remove(targetPath);
         throw new Error("Download failed: " + (getTransferErrorInfo(transfer) || ("HTTP " + statusCode)));
      }
      return true;
   };
}

// ----------------------------------------------------------------------------
// Smart Calibration Matcher
// ----------------------------------------------------------------------------

/**
 * Intelligent matching and scoring engine for calibration frames.
 *
 * Compares target light frame session parameters (camera model, binning, gain/offset,
 * exposure time, sensor temperature, filter) against available calibration groups
 * in Nebulis. Attached calibrations receive top confidence (100%), while library
 * masters are scored according to strict compatibility criteria and configurable tolerances.
 *
 * @param {NebulisSettings} config - Active settings configuration instance.
 * @constructor
 */
function CalibrationMatcher(config) {
   this.config = config;

   /**
    * Matches available calibration groups against target light frames/sessions
    */
   this.findMatches = function(selectedObject, sessions, allCalibrations, attachedCalibrations) {
      var matches = {
         darks: [],
         flats: [],
         bias: [],
         flatdarks: []
      };

      // Extract unique light parameters from sessions
      var lightSpecs = [];
      if (sessions && sessions.length > 0) {
         for (var s = 0; s < sessions.length; ++s) {
            var sess = sessions[s];
            lightSpecs.push({
               camera: (sess.camera || (sess.equipment && sess.equipment.camera) || "").toLowerCase().trim(),
               telescope: (sess.telescope || (sess.equipment && sess.equipment.telescope) || "").toLowerCase().trim(),
               gain: sess.gain !== undefined ? Number(sess.gain) : null,
               exposure: sess.exposure !== undefined ? Number(sess.exposure) : null,
               temp: sess.sensorTempC !== undefined ? Number(sess.sensorTempC) : null,
               binning: sess.binning || "1x1",
               filter: (sess.filter || "L").toUpperCase().trim()
            });
         }
      } else if (selectedObject) {
         lightSpecs.push({
            camera: (selectedObject.camera || "").toLowerCase().trim(),
            telescope: "",
            gain: null,
            exposure: null,
            temp: null,
            binning: "1x1",
            filter: "L"
         });
      }

      // Check attached calibrations first (highest confidence)
      var attachedKeys = {};
      if (attachedCalibrations && attachedCalibrations.length > 0) {
         for (var a = 0; a < attachedCalibrations.length; ++a) {
            var att = attachedCalibrations[a];
            var key = att.groupKey || (att.frameType + "_" + (att.filter || "") + "_" + (att.exposure || ""));
            attachedKeys[key] = true;
            this.addMatchItem(matches, att, 100, "Attached directly to " + selectedObject.name);
         }
      }

      // Evaluate library calibration groups
      if (allCalibrations && allCalibrations.length > 0) {
         for (var i = 0; i < allCalibrations.length; ++i) {
            var group = allCalibrations[i];
            var gKey = group.groupKey || (group.frameType + "_" + (group.filter || "") + "_" + (group.exposure || ""));
            if (attachedKeys[gKey]) continue; // Already added as attached

            var gType = (group.frameType || "").toLowerCase().replace(/[^a-z]/g, "");
            var gCamera = (group.camera || "").toLowerCase().trim();
            var gGain = group.gain !== undefined ? Number(group.gain) : null;
            var gExp = group.exposure !== undefined ? Number(group.exposure) : null;
            var gTemp = group.sensorTempC !== undefined ? Number(group.sensorTempC) : null;
            var gBin = group.binning || "1x1";
            var gFilter = (group.filter || "").toUpperCase().trim();

            for (var l = 0; l < lightSpecs.length; ++l) {
               var spec = lightSpecs[l];
               var score = 0;
               var reasons = [];

               // Camera match
               if (spec.camera && gCamera) {
                  if (spec.camera === gCamera || spec.camera.indexOf(gCamera) !== -1 || gCamera.indexOf(spec.camera) !== -1) {
                     score += 40;
                     reasons.push("Camera match (" + group.camera + ")");
                  } else {
                     continue; // Different camera, incompatible
                  }
               } else {
                  score += 20; // Generic match
               }

               // Binning match
               if (spec.binning === gBin) {
                  score += 15;
               } else {
                  continue; // Different binning
               }

               // Gain match
               if (spec.gain !== null && gGain !== null) {
                  if (Math.abs(spec.gain - gGain) < 0.1) {
                     score += 15;
                     reasons.push("Gain " + gGain);
                  } else {
                     continue; // Different gain
                  }
               }

               // Specific frame type rules
               if (gType === "dark") {
                  if (spec.exposure !== null && gExp !== null) {
                     var expDiff = Math.abs(spec.exposure - gExp);
                     var relDiff = spec.exposure > 0 ? (expDiff / spec.exposure) : 1;
                     if (expDiff >= 0.5 && relDiff > this.config.expTolerance) {
                        continue; // Incompatible dark exposure
                     }
                     score += 20;
                     reasons.push("Exposure " + gExp + "s");
                  }
                  if (spec.temp !== null && gTemp !== null) {
                     var tempDiff = Math.abs(spec.temp - gTemp);
                     if (tempDiff > this.config.tempTolerance) {
                        continue; // Outside temperature tolerance
                     }
                     score += 10;
                     reasons.push("Temp " + gTemp + "°C");
                  }
                  if (score >= 50) {
                     this.addMatchItem(matches, group, score, reasons.join(", "));
                     break;
                  }
               } else if (gType === "flat") {
                  if (spec.filter && gFilter && spec.filter === gFilter) {
                     score += 30;
                     reasons.push("Filter " + gFilter);
                     this.addMatchItem(matches, group, score, reasons.join(", "));
                     break;
                  }
               } else if (gType === "bias") {
                  score += 20;
                  reasons.push("Bias / Offset frame");
                  this.addMatchItem(matches, group, score, reasons.join(", "));
                  break;
               } else if (gType === "flatdark") {
                  this.addMatchItem(matches, group, score, reasons.join(", "));
                  break;
               }
            }
         }
      }

      return matches;
   };

   this.addMatchItem = function(matches, group, score, reason) {
      var type = (group.frameType || "").toLowerCase().replace(/[^a-z]/g, "");
      var item = {
         group: group,
         score: score,
         reason: reason,
         label: (group.name || group.frameType) + " (" + (group.filter || "No Filter") + 
                ", Exp: " + (group.exposure !== undefined ? group.exposure + "s" : "-") + 
                ", Gain: " + (group.gain !== undefined ? group.gain : "-") + 
                ", Files: " + (group.fileCount || (group.files ? group.files.length : 1)) + ")"
      };

      if (type === "dark" || type === "masterdark") matches.darks.push(item);
      else if (type === "flat" || type === "masterflat") matches.flats.push(item);
      else if (type === "bias" || type === "masterbias") matches.bias.push(item);
      else if (type === "flatdark") matches.flatdarks.push(item);
      else matches.darks.push(item);
   };
}

// ----------------------------------------------------------------------------
// PixInsight Settings & Preferences Dialog
// ----------------------------------------------------------------------------

/**
 * Dedicated sub-window for Nebulis configuration and preferences.
 * Callable from traditional PixInsight icons (toolbar gear / preferences button).
 *
 * @param {NebulisClient} client - Active API client instance.
 * @constructor
 * @extends {Dialog}
 */
var NebulisSettingsDialog = (typeof Dialog !== "undefined")
   ? class NebulisSettingsDialog extends Dialog {
        constructor(client) {
           super();
           this.restyle();

           var self = this;
           this.client = client;

           this.windowTitle = "Nebulis Settings & Connection";
           this.userResizable = true;
           this.setScaledMinSize(660, 520);

           var titleLabel = new Label(this);
           titleLabel.useRichText = true;
           titleLabel.text = "<b>Nebulis Settings & Preferences</b>";
           titleLabel.styleSheet = "font-size: 13pt; color: #0088cc;";

           var subLabel = new Label(this);
           subLabel.useRichText = true;
           subLabel.text = "Configure server connection credentials, download folders, and workspace preferences.";
           subLabel.styleSheet = "font-size: 8.5pt; color: #777;";

           // 1. Connection GroupBox
           var connGroup = new GroupBox(this);
           connGroup.title = "Server Connection & Authentication";

           var serverLabel = new Label(this);
           serverLabel.text = "Server URL:";
           serverLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;

           this.serverUrlEdit = new Edit(this);
           this.serverUrlEdit.text = nebulisConfig.serverUrl;
           this.serverUrlEdit.toolTip = "URL of your Nebulis observatory server (e.g. http://localhost:3002)";

           var apiKeyLabel = new Label(this);
           apiKeyLabel.text = "Nebulis API Key:";
           apiKeyLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;

           this.apiKeyEdit = new Edit(this);
           this.apiKeyEdit.text = nebulisConfig.apiKey;
           this.apiKeyEdit.toolTip = "Your Nebulis API key (from Settings > Account > API Key)";

           var apiHelpLabel = new Label(this);
           apiHelpLabel.useRichText = true;
           apiHelpLabel.text = "<small style='color: #888;'>Generate an API key in Nebulis: <b>Settings &gt; Account &gt; API Key</b></small>";

           this.testConnButton = new PushButton(this);
           this.testConnButton.text = "Test Connection";
           this.testConnButton.onClick = function() {
              self.testConnection();
           };

           this.connStatusLabel = new Label(this);
           this.connStatusLabel.text = "Status: Not tested";

           var serverRow = new HorizontalSizer;
           serverRow.spacing = 6;
           serverRow.add(serverLabel);
           serverRow.add(this.serverUrlEdit, 100);

           var apiRow = new HorizontalSizer;
           apiRow.spacing = 6;
           apiRow.add(apiKeyLabel);
           apiRow.add(this.apiKeyEdit, 100);

           var testRow = new HorizontalSizer;
           testRow.spacing = 8;
           testRow.add(this.testConnButton);
           testRow.add(this.connStatusLabel, 100);

           var connSizer = new VerticalSizer;
           connSizer.margin = 8;
           connSizer.spacing = 6;
           connSizer.add(serverRow);
           connSizer.add(apiRow);
           connSizer.add(apiHelpLabel);
           connSizer.add(testRow);
           connGroup.sizer = connSizer;

           // 2. Default Save Directories GroupBox (Download directory stays here!)
           var dirGroup = new GroupBox(this);
           dirGroup.title = "Local Download & Storage Directories";

           var mainDirLabel = new Label(this);
           mainDirLabel.text = "Download Directory / Projects Root:";

           this.mainDirEdit = new Edit(this);
           this.mainDirEdit.text = nebulisConfig.downloadDir;
           this.mainDirEdit.toolTip = "Base directory where downloaded target folders (lights and projects) will be stored";

           this.browseMainDirButton = new PushButton(this);
           this.browseMainDirButton.text = "Browse...";
           this.browseMainDirButton.onClick = function() {
              var gfd = new GetDirectoryDialog;
              gfd.caption = "Select Download Directory / Projects Root";
              gfd.initialPath = self.mainDirEdit.text;
              if (gfd.execute()) {
                 self.mainDirEdit.text = gfd.directory;
              }
           };

           var mainDirRow = new HorizontalSizer;
           mainDirRow.spacing = 6;
           mainDirRow.add(this.mainDirEdit, 100);
           mainDirRow.add(this.browseMainDirButton);

           this.useDedicatedCalCheck = new CheckBox(this);
           this.useDedicatedCalCheck.text = "Save calibrations in a dedicated shared folder (instead of inside object folder)";
           this.useDedicatedCalCheck.checked = nebulisConfig.useDedicatedCalibrationsDir;
           this.useDedicatedCalCheck.onCheck = function(checked) {
              self.calDirEdit.enabled = checked;
              self.browseCalDirButton.enabled = checked;
           };

           var calDirLabel = new Label(this);
           calDirLabel.text = "Dedicated Calibration Directory (Master Darks, Flats, Bias):";

           this.calDirEdit = new Edit(this);
           this.calDirEdit.text = nebulisConfig.calibrationsDir;
           this.calDirEdit.enabled = nebulisConfig.useDedicatedCalibrationsDir;

           this.browseCalDirButton = new PushButton(this);
           this.browseCalDirButton.text = "Browse...";
           this.browseCalDirButton.enabled = nebulisConfig.useDedicatedCalibrationsDir;
           this.browseCalDirButton.onClick = function() {
              var gfd = new GetDirectoryDialog;
              gfd.caption = "Select Dedicated Calibration Directory";
              gfd.initialPath = self.calDirEdit.text;
              if (gfd.execute()) {
                 self.calDirEdit.text = gfd.directory;
              }
           };

           var calDirRow = new HorizontalSizer;
           calDirRow.spacing = 6;
           calDirRow.add(this.calDirEdit, 100);
           calDirRow.add(this.browseCalDirButton);

           var subfoldersLabel = new Label(this);
           subfoldersLabel.text = "Subfolder Names (inside Object folder):";

           var lightsSubLabel = new Label(this);
           lightsSubLabel.text = "Lights:";
           this.lightsSubEdit = new Edit(this);
           this.lightsSubEdit.text = nebulisConfig.lightsSubfolder;
           this.lightsSubEdit.minWidth = 70;

           var calSubLabel = new Label(this);
           calSubLabel.text = "Calibrations:";
           this.calSubEdit = new Edit(this);
           this.calSubEdit.text = nebulisConfig.calibrationsSubfolder;
           this.calSubEdit.minWidth = 80;

           var projSubLabel = new Label(this);
           projSubLabel.text = "Project:";
           this.projSubEdit = new Edit(this);
           this.projSubEdit.text = nebulisConfig.projectSubfolder;
           this.projSubEdit.minWidth = 100;

           var subfoldersRow = new HorizontalSizer;
           subfoldersRow.spacing = 6;
           subfoldersRow.add(lightsSubLabel);
           subfoldersRow.add(this.lightsSubEdit);
           subfoldersRow.addSpacing(8);
           subfoldersRow.add(calSubLabel);
           subfoldersRow.add(this.calSubEdit);
           subfoldersRow.addSpacing(8);
           subfoldersRow.add(projSubLabel);
           subfoldersRow.add(this.projSubEdit);
           subfoldersRow.addStretch();

           var dirSizer = new VerticalSizer;
           dirSizer.margin = 8;
           dirSizer.spacing = 6;
           dirSizer.add(mainDirLabel);
           dirSizer.add(mainDirRow);
           dirSizer.add(this.useDedicatedCalCheck);
           dirSizer.add(calDirLabel);
           dirSizer.add(calDirRow);
           dirSizer.add(subfoldersLabel);
           dirSizer.add(subfoldersRow);
           dirGroup.sizer = dirSizer;

           // 3. Tolerances & Download Options
           var calOptionsGroup = new GroupBox(this);
           calOptionsGroup.title = "Preferences & Download Acceleration";

           this.fastDownloadCheck = new CheckBox(this);
           this.fastDownloadCheck.text = "Enable Fast Download Acceleration (curl via ExternalProcess)";
           this.fastDownloadCheck.checked = nebulisConfig.fastDownloadMode;

           var tempTolLabel = new Label(this);
           tempTolLabel.text = "Dark/Bias Temperature Tolerance (±°C):";
           this.tempTolEdit = new Edit(this);
           this.tempTolEdit.text = String(nebulisConfig.tempTolerance);
           this.tempTolEdit.maxWidth = 60;

           var expTolLabel = new Label(this);
           expTolLabel.text = "Dark Exposure Tolerance (±%):";
           this.expTolEdit = new Edit(this);
           this.expTolEdit.text = String(Math.round(nebulisConfig.expTolerance * 100));
           this.expTolEdit.maxWidth = 60;

           var tolRow = new HorizontalSizer;
           tolRow.spacing = 6;
           tolRow.add(tempTolLabel);
           tolRow.add(this.tempTolEdit);
           tolRow.addSpacing(16);
           tolRow.add(expTolLabel);
           tolRow.add(this.expTolEdit);
           tolRow.addStretch();

           var calOptSizer = new VerticalSizer;
           calOptSizer.margin = 8;
           calOptSizer.spacing = 6;
           calOptSizer.add(this.fastDownloadCheck);
           calOptSizer.add(tolRow);
           calOptionsGroup.sizer = calOptSizer;

           // Bottom Buttons (Save / Cancel)
           this.saveButton = new PushButton(this);
           this.saveButton.text = "Save Settings";
           this.saveButton.styleSheet = "font-weight: bold; background-color: #0088cc; color: white; padding: 6px 14px;";
           this.saveButton.onClick = function() {
              self.saveSettings();
           };

           this.cancelButton = new PushButton(this);
           this.cancelButton.text = "Cancel";
           this.cancelButton.onClick = function() {
              self.cancel();
           };

           var btnSizer = new HorizontalSizer;
           btnSizer.spacing = 8;
           btnSizer.addStretch();
           btnSizer.add(this.cancelButton);
           btnSizer.add(this.saveButton);

           var mainSizer = new VerticalSizer;
           mainSizer.margin = 8;
           mainSizer.spacing = 8;
           mainSizer.add(titleLabel);
           mainSizer.add(subLabel);
           mainSizer.add(connGroup);
           mainSizer.add(dirGroup);
           mainSizer.add(calOptionsGroup);
           mainSizer.add(btnSizer);
           this.sizer = mainSizer;

           this.testConnection = function() {
              this.connStatusLabel.text = "Status: Testing connection...";
              processUIMessages();
              this.client.config.serverUrl = this.serverUrlEdit.text.trim();
              this.client.config.apiKey = this.apiKeyEdit.text.trim();
              var res = this.client.testConnection();
              if (res.ok) {
                 this.connStatusLabel.text = "Status: OK! Successfully connected to Nebulis.";
                 this.connStatusLabel.styleSheet = "color: green;";
              } else {
                 if (res.statusCode === 401) {
                    this.connStatusLabel.text = "Status: API Key required or invalid (Settings > Account > API Key)";
                 } else {
                    this.connStatusLabel.text = "Status: Failed: " + res.message;
                 }
                 this.connStatusLabel.styleSheet = "color: red;";
              }
           };

           this.saveSettings = function() {
              nebulisConfig.serverUrl = this.serverUrlEdit.text.trim();
              nebulisConfig.apiKey = this.apiKeyEdit.text.trim();
              nebulisConfig.downloadDir = this.mainDirEdit.text.trim();
              nebulisConfig.useDedicatedCalibrationsDir = this.useDedicatedCalCheck.checked;
              nebulisConfig.calibrationsDir = this.calDirEdit.text.trim();
              nebulisConfig.lightsSubfolder = this.lightsSubEdit.text.trim() || "lights";
              nebulisConfig.calibrationsSubfolder = this.calSubEdit.text.trim() || "calibrations";
              nebulisConfig.projectSubfolder = this.projSubEdit.text.trim() || "processing_project";

              var t = parseFloat(this.tempTolEdit.text);
              if (!isNaN(t)) nebulisConfig.tempTolerance = t;
              var e = parseFloat(this.expTolEdit.text);
              if (!isNaN(e)) nebulisConfig.expTolerance = e / 100.0;
              nebulisConfig.fastDownloadMode = this.fastDownloadCheck.checked;

              nebulisConfig.save();

              this.client.config.serverUrl = nebulisConfig.serverUrl;
              this.client.config.apiKey = nebulisConfig.apiKey;

              this.ok();
           };
        }
     }
   : function NebulisSettingsDialogMock() {};

// ----------------------------------------------------------------------------
// PixInsight Main User Interface Dialog
// ----------------------------------------------------------------------------

/**
 * Custom PJSR Control that renders a preview bitmap for DSO objects.
 * Maintains aspect ratio and centers image against a styled dark canvas.
 *
 * @param {Control} parent - Parent GUI control.
 * @constructor
 * @extends {Control}
 */
var DSOThumbnailControl = (typeof Control !== "undefined")
   ? class DSOThumbnailControl extends Control {
        constructor(parent) {
           super(parent);
           var self = this;
           this.bitmap = null;
           this.boxColor = 0xff182234; // Deep space slate-blue
           this.borderColor = 0xff334155;
           this.setScaledMinSize(150, 140);
           this.setScaledMaxSize(170, 160);

           this.onPaint = function(x0, y0, x1, y1) {
              try {
                 var g = new Graphics(this);
                 g.fillRect(x0, y0, x1, y1, new Brush(self.boxColor));
                 g.pen = new Pen(self.borderColor, 1);
                 g.drawRect(0, 0, self.width - 1, self.height - 1);

                 if (self.bitmap && !self.bitmap.isNull && self.bitmap.width > 0 && self.bitmap.height > 0) {
                    var scale = Math.min((self.width - 6) / self.bitmap.width, (self.height - 6) / self.bitmap.height);
                    var sw = Math.round(self.bitmap.width * scale);
                    var sh = Math.round(self.bitmap.height * scale);
                    var left = Math.round((self.width - sw) / 2);
                    var top = Math.round((self.height - sh) / 2);
                    g.drawScaledBitmap(left, top, left + sw, top + sh, self.bitmap);
                 } else {
                    g.pen = new Pen(0xff64748b, 1);
                    g.font = new Font("sans-serif", 8);
                    var msg = "No DSO Preview";
                    var tw = g.font.width(msg);
                    g.drawText(Math.round((self.width - tw) / 2), Math.round(self.height / 2 + 4), msg);
                 }
                 g.end();
              } catch (err) {}
           };
        }

        setBitmap(bmp) {
           this.bitmap = (bmp instanceof Bitmap && !bmp.isNull) ? bmp : null;
           this.repaint();
        }

        loadFromFile(filePath) {
           try {
              if (typeof File !== "undefined" && File.exists(filePath)) {
                 var bmp = new Bitmap(filePath);
                 if (bmp && !bmp.isNull) {
                    this.setBitmap(bmp);
                    return true;
                 }
              }
           } catch (e) {}
           this.setBitmap(null);
           return false;
        }
     }
   : function DSOThumbnailControlMock() {};

/**
 * Main PJSR GUI Dialog window for the Nebulis Connector.
 *
 * Provides a tabbed interface with:
 * 1. Object & Session Browser: Filtering, session inspection, and calibration matching.
 * 2. Project Sync: Process icon (.xpsm) export, file upload, and project archive inspection.
 * 3. Settings & Connection: Server URL, API key, download destination, and tolerances.
 *
 * @param {NebulisClient} client - Configured API client instance.
 * @param {CalibrationMatcher} matcher - Configured calibration matcher instance.
 * @constructor
 * @extends {Dialog}
 */
var NebulisDialog = (typeof Dialog !== "undefined")
   ? class NebulisDialog extends Dialog {
        constructor(client, matcher) {
           super();
           this.restyle();

           var self = this;
           this.client = client;
           this.matcher = matcher;

   this.allObjects = [];
   this.filteredObjects = [];
   this.selectedObject = null;
   this.currentSessions = [];
   this.matchedCalibrations = null;
   this.allCalibrations = [];

   this.windowTitle = "Nebulis Connector";
   this.userResizable = true;
   this.setScaledMinSize(920, 680);

   // Title & Branding Bar with Settings Tool Button
   this.titleLabel = new Label(this);
   this.titleLabel.useRichText = true;
   this.titleLabel.text = "<b>Nebulis Astrophotography Library</b> &nbsp;<span style='font-size: 8.5pt; font-weight: bold; background-color: #0284c7; color: white; padding: 2px 8px; border-radius: 4px;'>v" + NEBULIS_VERSION + "</span>";
   this.titleLabel.styleSheet = "font-size: 14pt; color: #0088cc;";

   this.subTitleLabel = new Label(this);
   this.subTitleLabel.text = "Seamless workspace and calibration sync for PixInsight";
   this.subTitleLabel.styleSheet = "font-size: 9pt; color: #777;";

   var titleLeftSizer = new VerticalSizer;
   titleLeftSizer.add(this.titleLabel);
   titleLeftSizer.addSpacing(2);
   titleLeftSizer.add(this.subTitleLabel);

   this.settingsToolButton = new ToolButton(this);
   this.settingsToolButton.text = "⚙ Settings";
   this.settingsToolButton.toolTip = "Configure Nebulis Server Connection and Local Download Directories";
   this.settingsToolButton.onClick = function() {
      self.openSettingsDialog();
   };

   var headerSizer = new HorizontalSizer;
   headerSizer.margin = 6;
   headerSizer.add(titleLeftSizer, 100);
   headerSizer.add(this.settingsToolButton);

   // ==========================================
   // TAB 1: Library Download (Lights & Sessions)
   // ==========================================
   var browseControl = new Control(this);

   // Search bar
   this.searchEdit = new Edit(this);
   this.searchEdit.minWidth = 240;
   this.searchEdit.setScaledMinSize(240, 24);
   this.searchEdit.toolTip = "Filter objects by name (e.g. M42, NGC, Heart, IC 1805)";
   this.searchEdit.onTextUpdated = function() {
      self.filterObjectList();
   };

   this.searchLabel = new Label(this);
   this.searchLabel.text = "Search:";
   this.searchLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;

   this.refreshButton = new PushButton(this);
   this.refreshButton.text = "Refresh";
   this.refreshButton.toolTip = "Reload objects from Nebulis server";
   this.refreshButton.onClick = function() {
      self.loadLibraryData();
   };

   var searchSizer = new HorizontalSizer;
   searchSizer.spacing = 8;
   searchSizer.add(this.searchLabel);
   searchSizer.add(this.searchEdit, 100);
   searchSizer.add(this.refreshButton);

   // Objects TreeBox
   this.objectTree = new TreeBox(this);
   this.objectTree.headerVisible = true;
   this.objectTree.numberOfColumns = 5;
   this.objectTree.setHeaderText(0, "Object Name");
   this.objectTree.setHeaderText(1, "Constellation");
   this.objectTree.setHeaderText(2, "Type");
   this.objectTree.setHeaderText(3, "Sessions");
   this.objectTree.setHeaderText(4, "Total Integration");
   this.objectTree.setScaledMinSize(580, 220);

   this.objectTree.onCurrentNodeUpdated = function() {
      var node = self.objectTree.currentNode;
      if (!node) return;
      var objId = node.text(0);
      self.onObjectSelected(objId);
   };

   // Target Details & Preview Group
   this.detailGroupBox = new GroupBox(this);
   this.detailGroupBox.title = "Target Object Details & Preview";

   this.dsoThumbnail = new DSOThumbnailControl(this);

   this.infoBox = new Label(this);
   this.infoBox.wordWrapping = true;
   this.infoBox.useRichText = true;
   this.infoBox.text = "Select an object to inspect details.";
   this.infoBox.margin = 4;

   var detailInnerSizer = new HorizontalSizer;
   detailInnerSizer.spacing = 8;
   detailInnerSizer.margin = 4;
   detailInnerSizer.add(this.dsoThumbnail);
   detailInnerSizer.add(this.infoBox, 100);
   this.detailGroupBox.sizer = detailInnerSizer;

   // Sessions Tree
   this.sessionsTree = new TreeBox(this);
   this.sessionsTree.headerVisible = true;
   this.sessionsTree.numberOfColumns = 4;
   this.sessionsTree.setHeaderText(0, "Session Date");
   this.sessionsTree.setHeaderText(1, "Filter & Exposure");
   this.sessionsTree.setHeaderText(2, "Subframes");
   this.sessionsTree.setHeaderText(3, "Camera / Telescope");
   this.sessionsTree.setScaledMinSize(480, 160);

   var sessionDetailSizer = new HorizontalSizer;
   sessionDetailSizer.spacing = 8;
   sessionDetailSizer.add(this.detailGroupBox, 48);
   sessionDetailSizer.add(this.sessionsTree, 52);

   // Download Action Area (Download directory field is kept in Settings window!)
   this.pathPreviewLabel = new Label(this);
   this.pathPreviewLabel.useRichText = true;
   this.pathPreviewLabel.margin = 2;

   this.updateWorkspacePathPreview = function() {
      var objName = self.selectedObject ? (self.selectedObject.name || self.selectedObject.id) : "Target";
      var lightsP = nebulisConfig.getResolvedLightsDir(objName);
      self.pathPreviewLabel.text = "<small style='color: #888;'>Destination: <b>" + lightsP + "</b> &nbsp; <i>(configure directory in ⚙ Settings)</i></small>";
   };
   this.updateWorkspacePathPreview();

   this.downloadButton = new PushButton(this);
   this.downloadButton.text = "Download Light Subframes (Sessions)";
   this.downloadButton.styleSheet = "font-weight: bold; background-color: #0088cc; color: white; padding: 7px 18px; font-size: 10pt;";
   this.downloadButton.toolTip = "Download all light subframes for this object into your local lights folder";
   this.downloadButton.onClick = function() {
      self.startWorkspaceDownload();
   };

   this.openCalTabButton = new PushButton(this);
   this.openCalTabButton.text = "Go to Calibration Library ➔";
   this.openCalTabButton.toolTip = "Switch to Calibration Library tab to browse and download Darks, Flats, and Bias";
   this.openCalTabButton.onClick = function() {
      if (self.tabBox) self.tabBox.currentPageIndex = 1;
   };

   var actionSizer = new HorizontalSizer;
   actionSizer.spacing = 8;
   actionSizer.add(this.pathPreviewLabel, 100);
   actionSizer.add(this.openCalTabButton);
   actionSizer.add(this.downloadButton);

   var tab1Sizer = new VerticalSizer;
   tab1Sizer.spacing = 8;
   tab1Sizer.add(searchSizer);
   tab1Sizer.add(this.objectTree, 60);
   tab1Sizer.add(sessionDetailSizer, 40);
   tab1Sizer.add(actionSizer);
   browseControl.sizer = tab1Sizer;

   // ==========================================
   // TAB 2: Calibration Library Browser
   // ==========================================
   var calLibControl = new Control(this);

   var calLibInfo = new Label(this);
   calLibInfo.wordWrapping = true;
   calLibInfo.text = "Browse all Master Darks, Flats, Bias, and Flat-Darks from your Nebulis library. " +
                     "For Flats, the linked target object is displayed below. Expand any group to view subframes.";

   // Search & Filter Row
   var calSearchLabel = new Label(this);
   calSearchLabel.text = "Filter Calibrations:";
   calSearchLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;

   this.calSearchEdit = new Edit(this);
   this.calSearchEdit.toolTip = "Filter calibrations by frame type, rig name, linked object, gain, or exposure";
   this.calSearchEdit.onTextUpdated = function() {
      self.filterCalLibraryTree();
   };

   this.calTypeCombo = new ComboBox(this);
   this.calTypeCombo.addItem("All Types");
   this.calTypeCombo.addItem("Darks only");
   this.calTypeCombo.addItem("Flats only");
   this.calTypeCombo.addItem("Bias only");
   this.calTypeCombo.addItem("Flat-Darks only");
   this.calTypeCombo.onItemSelected = function() {
      self.filterCalLibraryTree();
   };

   this.refreshCalLibButton = new PushButton(this);
   this.refreshCalLibButton.text = "Refresh Library";
   this.refreshCalLibButton.onClick = function() {
      self.loadCalibrationLibraryData();
   };

   var calFilterRow = new HorizontalSizer;
   calFilterRow.spacing = 6;
   calFilterRow.add(calSearchLabel);
   calFilterRow.add(this.calSearchEdit, 100);
   calFilterRow.add(this.calTypeCombo);
   calFilterRow.add(this.refreshCalLibButton);

   // TreeBox for all calibrations (7 columns: includes Linked Object for flats!)
   this.allCalTree = new TreeBox(this);
   this.allCalTree.headerVisible = true;
   this.allCalTree.numberOfColumns = 7;
   this.allCalTree.setHeaderText(0, "Calibration Set / Subframe File");
   this.allCalTree.setHeaderText(1, "Type");
   this.allCalTree.setHeaderText(2, "Rig / Scope");
   this.allCalTree.setHeaderText(3, "Linked Object");
   this.allCalTree.setHeaderText(4, "Exp / Bin / Gain");
   this.allCalTree.setHeaderText(5, "Temp / Filter");
   this.allCalTree.setHeaderText(6, "Files / Size");
   this.allCalTree.setScaledMinSize(860, 260);

   // Destination folder note (download directory configured in Settings window!)
   this.calDestNoteLabel = new Label(this);
   this.calDestNoteLabel.useRichText = true;
   this.updateCalPathPreview = function() {
      var calPath = nebulisConfig.getResolvedCalibrationsDir();
      self.calDestNoteLabel.text = "<small style='color: #888;'>Destination: <b>" + calPath + "</b> &nbsp; <i>(configure directory in ⚙ Settings)</i></small>";
   };
   this.updateCalPathPreview();

   // Action buttons
   this.selectAllCalButton = new PushButton(this);
   this.selectAllCalButton.text = "Select All";
   this.selectAllCalButton.onClick = function() {
      self.setAllCalChecked(true);
   };

   this.deselectAllCalButton = new PushButton(this);
   this.deselectAllCalButton.text = "Deselect All";
   this.deselectAllCalButton.onClick = function() {
      self.setAllCalChecked(false);
   };

   this.downloadCalLibButton = new PushButton(this);
   this.downloadCalLibButton.text = "Download Selected Calibrations";
   this.downloadCalLibButton.styleSheet = "font-weight: bold; background-color: #0088cc; color: white; padding: 7px 18px; font-size: 10pt;";
   this.downloadCalLibButton.onClick = function() {
      self.downloadSelectedCalibrations();
   };

   var calActionRow = new HorizontalSizer;
   calActionRow.spacing = 8;
   calActionRow.add(this.calDestNoteLabel, 100);
   calActionRow.add(this.selectAllCalButton);
   calActionRow.add(this.deselectAllCalButton);
   calActionRow.add(this.downloadCalLibButton);

   var tabCalSizer = new VerticalSizer;
   tabCalSizer.spacing = 8;
   tabCalSizer.margin = 6;
   tabCalSizer.add(calLibInfo);
   tabCalSizer.add(calFilterRow);
   tabCalSizer.add(this.allCalTree, 100);
   tabCalSizer.add(calActionRow);
   calLibControl.sizer = tabCalSizer;

   // ==========================================
   // TAB 3: Project Management & Cloud Sync
   // ==========================================
   var projectControl = new Control(this);

   var projInfo = new Label(this);
   projInfo.wordWrapping = true;
   projInfo.text = "Nebulis allows you to sync PixInsight process containers, icons (.xpsm), and processing archives " +
                   "directly with your library object, ensuring your exact workflows are backed up and reproducible.";

   this.projFilesTree = new TreeBox(this);
   this.projFilesTree.headerVisible = true;
   this.projFilesTree.numberOfColumns = 3;
   this.projFilesTree.setHeaderText(0, "Project File");
   this.projFilesTree.setHeaderText(1, "Size");
   this.projFilesTree.setHeaderText(2, "Last Modified");
   this.projFilesTree.setScaledMinSize(860, 240);

   this.refreshProjFilesButton = new PushButton(this);
   this.refreshProjFilesButton.text = "Refresh Server Project Files";
   this.refreshProjFilesButton.onClick = function() {
      self.loadProcessingProject();
   };

   this.saveIconsButton = new PushButton(this);
   this.saveIconsButton.text = "Sync Process Icons (.xpsm) to Nebulis...";
   this.saveIconsButton.toolTip = "Upload a saved .xpsm process icons file directly into this object's processing_project folder";
   this.saveIconsButton.onClick = function() {
      self.exportWorkspaceIcons();
   };

   this.uploadProjectFileButton = new PushButton(this);
   this.uploadProjectFileButton.text = "Upload Local File to Nebulis Project...";
   this.uploadProjectFileButton.onClick = function() {
      self.uploadLocalProjectFile();
   };

   var projActionSizer = new HorizontalSizer;
   projActionSizer.spacing = 8;
   projActionSizer.add(this.refreshProjFilesButton);
   projActionSizer.addSpacing(16);
   projActionSizer.add(this.saveIconsButton);
   projActionSizer.add(this.uploadProjectFileButton);
   projActionSizer.addStretch();

   var tab2Sizer = new VerticalSizer;
   tab2Sizer.spacing = 8;
   tab2Sizer.margin = 6;
   tab2Sizer.add(projInfo);
   tab2Sizer.add(this.projFilesTree, 100);
   tab2Sizer.add(projActionSizer);
   projectControl.sizer = tab2Sizer;

   // Main Tab Box (exactly 3 tabs)
   this.tabBox = new TabBox(this);
   this.tabBox.addPage(browseControl, "Library & Download");
   this.tabBox.addPage(calLibControl, "Calibration Library");
   this.tabBox.addPage(projectControl, "Project Sync");

   // Bottom Status & Log Box
   this.logView = new Edit(this);
   this.logView.multiline = true;
   this.logView.readOnly = true;
   this.logView.setScaledMinSize(860, 70);

   // Dialog Bottom Buttons (Settings sub-window button + Close)
   this.settingsDialogButton = new PushButton(this);
   this.settingsDialogButton.text = "⚙ Settings & Preferences...";
   this.settingsDialogButton.toolTip = "Open Nebulis Settings & Preferences dialog";
   this.settingsDialogButton.onClick = function() {
      self.openSettingsDialog();
   };

   this.closeButton = new PushButton(this);
   this.closeButton.text = "Close";
   this.closeButton.onClick = function() {
      self.ok();
   };

   var bottomSizer = new HorizontalSizer;
   bottomSizer.spacing = 8;
   bottomSizer.add(this.settingsDialogButton);
   bottomSizer.addStretch();
   bottomSizer.add(this.closeButton);

   // Overall Dialog Sizer
   var mainSizer = new VerticalSizer;
   mainSizer.margin = 8;
   mainSizer.spacing = 6;
   mainSizer.add(headerSizer);
   mainSizer.add(this.tabBox, 100);
   mainSizer.add(this.logView);
   mainSizer.add(bottomSizer);
   this.sizer = mainSizer;

   // -------------------------------------------------------------------------
   // Event Handlers & Operations
   // -------------------------------------------------------------------------
   this.log = function(msg) {
      console.writeln("[Nebulis] " + msg);
      this.logView.text = this.logView.text + "\n" + msg;
   };

   this.openSettingsDialog = function() {
      var dlg = new NebulisSettingsDialog(this.client);
      if (dlg.execute()) {
         this.log("Settings saved to PixInsight registry.");
         this.updateWorkspacePathPreview();
         this.updateCalPathPreview();
         this.loadLibraryData();
      }
   };

   this.testConnection = function() {
      this.connStatusLabel.text = "Status: Testing connection...";
      processUIMessages();
      this.client.config.serverUrl = this.serverUrlEdit.text.trim();
      this.client.config.apiKey = this.apiKeyEdit.text.trim();
      var res = this.client.testConnection();
      if (res.ok) {
         this.connStatusLabel.text = "Status: OK! Successfully connected to Nebulis.";
         this.connStatusLabel.styleSheet = "color: green;";
         self.loadLibraryData();
      } else {
         if (res.statusCode === 401) {
            this.connStatusLabel.text = "Status: API Key required or invalid (Settings > Account > API Key)";
         } else {
            this.connStatusLabel.text = "Status: Failed: " + res.message;
         }
         this.connStatusLabel.styleSheet = "color: red;";
      }
   };

   this.loadLibraryData = function() {
      if (!this.client.config.apiKey || this.client.config.apiKey.trim().length === 0) {
         this.infoBox.text = "<b>API Key Required</b><br/><br/>" +
            "Your Nebulis server requires an API Key.<br/><br/>" +
            "1. In your Nebulis web browser, open <b>Settings &gt; Account &gt; API Key</b>.<br/>" +
            "2. Click <b>New API Key</b> and copy it.<br/>" +
            "3. Click <b>⚙ Settings</b> (top right or bottom) to paste and save your key.";
         return;
      }

      try {
         this.log("Connecting to Nebulis library at " + this.client.normalizeBaseUrl() + "...");
         processUIMessages();
         this.allObjects = this.client.fetchObjects();
         this.log("Fetched " + this.allObjects.length + " objects from Nebulis.");
         this.filterObjectList();

         this.loadCalibrationLibraryData();
      } catch (err) {
         this.log("Notice: " + err.message);
         if (err.message && (err.message.indexOf("Authentication required") !== -1 || err.message.indexOf("401") !== -1)) {
            this.infoBox.text = "<b>API Key Required</b><br/><br/>" +
               "Your Nebulis server requires an API Key.<br/><br/>" +
               "1. In your Nebulis web browser, open <b>Settings &gt; Account &gt; API Key</b>.<br/>" +
               "2. Click <b>Generate API Key</b> and copy it.<br/>" +
               "3. Click <b>⚙ Settings</b> above to configure and save your API Key.";
         }
      }
   };

   this.loadCalibrationLibraryData = function() {
      try {
         this.allCalibrations = this.client.fetchCalibrations();
         this.log("Loaded " + this.allCalibrations.length + " calibration sets from library.");
         this.filterCalLibraryTree();
      } catch (e) {
         this.log("Error loading calibrations: " + e.message);
      }
   };

   this.filterCalLibraryTree = function() {
      this.allCalTree.clear();
      var query = (this.calSearchEdit.text || "").toLowerCase().trim();
      var filterIdx = this.calTypeCombo ? this.calTypeCombo.currentItem : 0;

      for (var i = 0; i < this.allCalibrations.length; ++i) {
         var grp = this.allCalibrations[i];
         var type = (grp.frameType || "").toLowerCase();

         if (filterIdx === 1 && type !== "dark") continue;
         if (filterIdx === 2 && type !== "flat") continue;
         if (filterIdx === 3 && type !== "bias") continue;
         if (filterIdx === 4 && type !== "flatdark") continue;

         var linkedDisplay = grp.linkedObject || "—";
         if (type === "flat" || type === "flatdark") {
            if (!grp.attachments || grp.attachments.length === 0) {
               linkedDisplay = "Unattached (Shared)";
            }
         } else if (type === "dark" || type === "bias") {
            linkedDisplay = "Rig Master (" + (grp.scopeLabel || "All") + ")";
         }

         var searchTarget = (grp.name + " " + grp.frameType + " " + (grp.scopeLabel || "") + " " + (grp.filter || "") + " " + linkedDisplay).toLowerCase();
         if (query.length > 0 && searchTarget.indexOf(query) === -1) continue;

         var groupNode = new TreeBoxNode(this.allCalTree);
         groupNode.checkable = true;
         groupNode.checked = false;
         groupNode.setText(0, grp.name || grp.typeLabel);
         groupNode.setText(1, grp.typeLabel || grp.frameType);
         groupNode.setText(2, grp.scopeLabel || "Default");
         groupNode.setText(3, linkedDisplay);
         groupNode.setText(4, grp.exposure + "s | Bin " + grp.binning + " | Gain " + (grp.gain !== null ? grp.gain : "-"));
         groupNode.setText(5, (grp.filter ? ("[" + grp.filter + "] ") : "") + (grp.sensorTempC !== null ? (grp.sensorTempC + "°C") : "-"));

         var mb = grp.bytes ? (Math.round(grp.bytes / (1024 * 1024)) + " MB") : "";
         groupNode.setText(6, grp.fileCount + " files" + (mb ? " (" + mb + ")" : ""));
         groupNode.calGroup = grp;

         if (grp.files && grp.files.length > 0) {
            for (var f = 0; f < grp.files.length; ++f) {
               var file = grp.files[f];
               var fileNode = new TreeBoxNode(groupNode);
               fileNode.setText(0, file.name);
               fileNode.setText(1, grp.frameType);
               fileNode.setText(2, grp.scopeLabel || "");
               fileNode.setText(3, linkedDisplay);
               var expStr = (file.info && file.info.exposureSec !== undefined) ? (file.info.exposureSec + "s") : (grp.exposure + "s");
               var gainStr = (file.info && file.info.gain !== undefined) ? ("Gain " + file.info.gain) : "";
               fileNode.setText(4, expStr + (gainStr ? (" | " + gainStr) : ""));
               var fileFilter = (file.info && file.info.filterLabel) ? file.info.filterLabel : grp.filter;
               fileNode.setText(5, (fileFilter ? ("[" + fileFilter + "] ") : "") + ((file.info && file.info.sensorTempC !== undefined) ? (file.info.sensorTempC + "°C") : ""));
               fileNode.setText(6, file.size ? (Math.round(file.size / (1024 * 1024) * 10) / 10 + " MB") : "");
            }
         }
      }
   };

   this.setAllCalChecked = function(checked) {
      for (var i = 0; i < this.allCalTree.numberOfChildren; ++i) {
         var node = this.allCalTree.child(i);
         node.checked = checked;
      }
   };

   this.downloadSelectedCalibrations = function() {
      var destDir = this.calLibDestDirEdit.text.trim();
      if (!destDir) {
         (new MessageBox("Please specify a destination folder for calibrations.", "Nebulis", StdIcon_Warning, StdButton_Ok)).execute();
         return;
      }

      var selectedGroups = [];
      for (var i = 0; i < this.allCalTree.numberOfChildren; ++i) {
         var node = this.allCalTree.child(i);
         if (node.checked && node.calGroup) {
            selectedGroups.push(node.calGroup);
         }
      }

      if (selectedGroups.length === 0) {
         (new MessageBox("Please check at least one calibration set to download.", "Nebulis", StdIcon_Warning, StdButton_Ok)).execute();
         return;
      }

      if (!File.directoryExists(destDir)) {
         File.createDirectory(destDir, true);
      }

      this.log("Starting download of " + selectedGroups.length + " calibration bundles to " + destDir + "...");
      processUIMessages();

      var downloadedCount = 0;
      var failedCount = 0;

      for (var g = 0; g < selectedGroups.length; ++g) {
         var grp = selectedGroups[g];
         try {
            var linkData = this.client.requestCalibrationDownloadLink(grp.scope, grp.folderName, grp.key);
            if (linkData && (linkData.url || linkData.downloadUrl)) {
               var dlUrl = linkData.url || linkData.downloadUrl;
               var zipName = linkData.filename || (grp.frameType + "_" + (g + 1) + ".zip");
               var targetFile = destDir + "/" + zipName;
               this.log("Downloading " + zipName + " (" + grp.fileCount + " files)...");
               processUIMessages();

               this.client.downloadFileToDisk(dlUrl, targetFile);
               if (File.exists(targetFile)) {
                  this.log("Saved " + zipName + " (" + getFileSize(targetFile) + " bytes).");
                  downloadedCount++;
               }
            }
         } catch (e) {
            this.log("Error downloading " + (grp.name || grp.key) + ": " + e.message);
            failedCount++;
         }
      }

      var msg = "Downloaded " + downloadedCount + " calibration bundle(s) successfully into:\n" + destDir;
      if (failedCount > 0) msg += "\n\n(" + failedCount + " bundles failed to download)";
      (new MessageBox(msg, "Nebulis Calibrations", StdIcon_Information, StdButton_Ok)).execute();
   };

   this.filterObjectList = function() {
      this.objectTree.clear();
      var term = this.searchEdit.text.toLowerCase().trim();
      this.filteredObjects = [];

      for (var i = 0; i < this.allObjects.length; ++i) {
         var obj = this.allObjects[i];
         var name = (obj.name || obj.displayName || obj.id || "").toString();
         var constel = (obj.constellation || "").toString();
         var type = (obj.type || obj.classification || "Deep Sky").toString();

         if (term.length > 0) {
            if (name.toLowerCase().indexOf(term) === -1 &&
                constel.toLowerCase().indexOf(term) === -1 &&
                type.toLowerCase().indexOf(term) === -1) {
               continue;
            }
         }

         this.filteredObjects.push(obj);

         var node = new TreeBoxNode(this.objectTree);
         node.setText(0, name);
         node.setText(1, constel);
         node.setText(2, type);
         node.setText(3, String(obj.sessionCount !== undefined ? obj.sessionCount : (obj.sessions ? obj.sessions.length : 1)));
         node.setText(4, obj.totalExposure ? (Math.round(obj.totalExposure / 60) + " min") : (obj.integrationTime || "-"));
      }
   };

   this.loadDSOThumbnail = function(obj) {
      if (!obj) {
         if (this.dsoThumbnail) this.dsoThumbnail.setBitmap(null);
         return;
      }

      var thumbUrl = obj.thumbnailUrl;
      if (!thumbUrl && (obj.id || obj.catalogId)) {
         thumbUrl = "/api/v1/library/objects/" + encodeURIComponent(obj.id || obj.catalogId) + "/thumbnail";
      }

      if (!thumbUrl) {
         if (this.dsoThumbnail) this.dsoThumbnail.setBitmap(null);
         return;
      }

      try {
         var tmpDir = (typeof File !== "undefined" && File.systemTempDirectory) ? File.systemTempDirectory : "/tmp";
         var safeId = (obj.id || obj.folderName || "dso").replace(/[^a-zA-Z0-9_\-]/g, "_");
         var localThumbPath = tmpDir + "/neb_thumb_" + safeId + ".jpg";

         // Download thumbnail from Nebulis server if not cached
         if (!File.exists(localThumbPath)) {
            this.client.downloadFileToDisk(thumbUrl, localThumbPath);
         }

         if (File.exists(localThumbPath)) {
            this.dsoThumbnail.loadFromFile(localThumbPath);
            return;
         }
      } catch (err) {
         // Silently fall back if thumbnail preview fails
      }
      if (this.dsoThumbnail) this.dsoThumbnail.setBitmap(null);
   };

   this.onObjectSelected = function(objName) {
      var found = null;
      for (var i = 0; i < this.filteredObjects.length; ++i) {
         var o = this.filteredObjects[i];
         if ((o.name || o.displayName || o.id) === objName) {
            found = o;
            break;
         }
      }
      if (!found) return;

      this.selectedObject = found;
      var objId = found.id || found.name;
      var folderName = found.folderName || found.folder || found.relativePath || found.id || "";
      var observatoryPath = "library/" + folderName;
      var localPath = nebulisConfig.getResolvedLightsDir(found.folderName || found.name || found.id);

      var constel = found.constellation && found.constellation !== "Unknown" ? found.constellation : "";
      if (!constel && found.description) {
         var cm = found.description.match(/constellation\s+([A-Za-z]+)/i);
         if (cm) constel = cm[1];
      }
      if (!constel) constel = "Unknown";

      this.infoBox.text = "<b>Object:</b> " + (found.name || found.id) + "<br/>" +
                          "<b>Catalog ID:</b> " + (found.catalogId || found.id) + "<br/>" +
                          "<b>Constellation:</b> " + constel + "<br/>" +
                          "<b>Type:</b> " + (found.type || "Deep Sky Object") + "<br/>" +
                          "<b>Sessions:</b> " + (found.sessionCount !== undefined ? found.sessionCount : (found.sessions ? found.sessions.length : 1)) + "<br/>" +
                          "<b>Observatory:</b> " + observatoryPath + "<br/>" +
                          "<b>Local Lights:</b> <small>" + localPath + "</small>";

      // Load DSO Thumbnail Screenshot
      this.loadDSOThumbnail(found);

      // Load sessions
      this.sessionsTree.clear();
      try {
         this.currentSessions = this.client.fetchSessions(objId);
         for (var s = 0; s < this.currentSessions.length; ++s) {
            var sess = this.currentSessions[s];
            var sNode = new TreeBoxNode(this.sessionsTree);

            // Col 0: Session Date
            var dateStr = sess.sessionDate || sess.date || "Unknown Date";
            sNode.setText(0, dateStr);

            // Col 1: Filter & Exposure
            var filterVal = sess.filter || "No filter";
            var expVal = sess.exposure ? String(sess.exposure) : (sess.exposureSec ? (sess.exposureSec + "s") : "");
            if (expVal && !expVal.toLowerCase().endsWith("s")) expVal += "s";
            var filterCol = filterVal + (expVal ? (" (" + expVal + ")") : "");
            sNode.setText(1, filterCol);

            // Col 2: Subframes count
            var subframeCount = (sess.subFrameCount !== undefined && sess.subFrameCount !== null)
               ? sess.subFrameCount
               : ((sess.fitsCount !== undefined && sess.fitsCount !== null)
                  ? sess.fitsCount
                  : ((sess.fileCount !== undefined && sess.fileCount !== null)
                     ? sess.fileCount
                     : (sess.frameCount || "-")));
            sNode.setText(2, String(subframeCount));

            // Col 3: Camera / Telescope Rig
            var rigStr = sess.telescopeName || sess.telescope || (sess.equipment && (sess.equipment.telescope || sess.equipment.camera)) || sess.camera || "Rig";
            var camStr = sess.cameraName || sess.camera || "";
            var equipCol = (camStr && camStr !== rigStr) ? (camStr + " / " + rigStr) : rigStr;
            sNode.setText(3, equipCol);
         }
      } catch (sessErr) {
         this.log("Sessions info: " + sessErr.message);
      }

      // Load processing project summary
      this.loadProcessingProject();

      // Update workspace path preview for the selected object
      this.updateWorkspacePathPreview();
   };

   this.loadProcessingProject = function() {
      if (!this.selectedObject) return;
      var objId = this.selectedObject.id || this.selectedObject.name;
      this.projFilesTree.clear();

      try {
         var summary = this.client.fetchProcessingProjectSummary(objId);
         if (summary && summary.files && summary.files.length > 0) {
            for (var f = 0; f < summary.files.length; ++f) {
               var file = summary.files[f];
               var fNode = new TreeBoxNode(this.projFilesTree);
               fNode.setText(0, file.name);
               fNode.setText(1, Math.round(file.size / 1024) + " KB");
               fNode.setText(2, file.mtime || "-");
            }
         } else {
            var emptyNode = new TreeBoxNode(this.projFilesTree);
            emptyNode.setText(0, "No project files stored yet for this object.");
         }
      } catch (e) {
         this.log("Project sync inspect error: " + e.message);
      }
   };

   this.startWorkspaceDownload = function() {
      if (!this.selectedObject) {
         (new MessageBox("Please select an object first.", "Nebulis", StdIcon_Warning, StdButton_Ok)).execute();
         return;
      }

      var objId = this.selectedObject.id || this.selectedObject.name;
      var objCleanName = (this.selectedObject.name || objId).replace(/[^a-zA-Z0-9_\-]/g, "_");

      var targetObjDir = nebulisConfig.getResolvedWorkspaceDir(objCleanName);
      var lightsDir = nebulisConfig.getResolvedLightsDir(objCleanName);
      var projDir = nebulisConfig.getResolvedProjectDir(objCleanName);

      this.log("Starting lights download for " + objCleanName);
      this.log("Target Directory: " + lightsDir);
      processUIMessages();

      try {
         if (!File.directoryExists(targetObjDir)) {
            File.createDirectory(targetObjDir, true);
         }
         if (!File.directoryExists(lightsDir)) {
            File.createDirectory(lightsDir, true);
         }
         if (!File.directoryExists(projDir)) {
            File.createDirectory(projDir, true);
         }

         // Download sessions zip bundle into lightsDir
         var downloadUrl = "/api/v1/library/download/objects/" + encodeURIComponent(objId);
         var zipDest = lightsDir + "/sessions_bundle.zip";
         this.log("Downloading object sessions to " + zipDest + "...");
         processUIMessages();

         this.client.downloadFileToDisk(downloadUrl, zipDest, function(bytes) {
            // progress updates
         });
         this.log("Downloaded session archive (" + (File.exists(zipDest) ? getFileSize(zipDest) : 0) + " bytes).");

         var summaryMsg = "Lights download completed successfully!\n\n" +
                          "• Target Object: " + (this.selectedObject.name || objId) + "\n" +
                          "• Lights saved to:\n  " + lightsDir;
         (new MessageBox(summaryMsg, "Nebulis", StdIcon_Information, StdButton_Ok)).execute();
      } catch (err) {
         this.log("Download failed: " + err.message);
         (new MessageBox("Download failed: " + err.message, "Nebulis Error", StdIcon_Error, StdButton_Ok)).execute();
      }
   };

   this.exportWorkspaceIcons = function() {
      if (!this.selectedObject) {
         (new MessageBox("Please select an object first.", "Nebulis", StdIcon_Warning, StdButton_Ok)).execute();
         return;
      }

      var objId = this.selectedObject.id || this.selectedObject.name;
      var ofd = new OpenFileDialog;
      ofd.caption = "Select Process Icons File (.xpsm) to Sync with Nebulis";
      ofd.filters = [["PixInsight Process Icon Files (*.xpsm)", "*.xpsm"], ["All files", "*.*"]];
      ofd.initialPath = nebulisConfig.downloadDir;

      if (ofd.execute()) {
         var filePath = ofd.fileName;
         try {
            var iconFile = new File;
            iconFile.openForReading(filePath);
            var content = iconFile.read(DataType_ByteArray, iconFile.size);
            iconFile.close();

            var base64Content = content.toBase64();
            var relativeName = File.extractName(filePath) + File.extractExtension(filePath);

            this.client.saveProjectFile(objId, relativeName, base64Content.toString());
            this.log("Uploaded " + relativeName + " to Nebulis project!");
            this.loadProcessingProject();

            (new MessageBox("Process icons successfully uploaded and synced with Nebulis project!",
                            "Nebulis", StdIcon_Information, StdButton_Ok)).execute();
         } catch (e) {
            this.log("Upload failed: " + e.message);
            (new MessageBox("Upload failed: " + e.message, "Nebulis Error", StdIcon_Error, StdButton_Ok)).execute();
         }
      }
   };

   this.uploadLocalProjectFile = function() {
      if (!this.selectedObject) {
         (new MessageBox("Please select an object first.", "Nebulis", StdIcon_Warning, StdButton_Ok)).execute();
         return;
      }

      var objId = this.selectedObject.id || this.selectedObject.name;
      var ofd = new OpenFileDialog;
      ofd.caption = "Select File to Upload to Nebulis Project";
      ofd.filters = [
         ["PixInsight Files (*.xpsm, *.xisf, *.pxi, *.js, *.json)", "*.xpsm;*.xisf;*.pxi;*.js;*.json"],
         ["All files", "*.*"]
      ];

      if (ofd.execute()) {
         var filePath = ofd.fileName;
         try {
            var f = new File;
            f.openForReading(filePath);
            var rawBytes = f.read(DataType_ByteArray, f.size);
            f.close();

            var base64 = rawBytes.toBase64();
            var fileName = File.extractName(filePath) + File.extractExtension(filePath);

            this.client.saveProjectFile(objId, fileName, base64.toString());
            this.log("Uploaded " + fileName + " (" + rawBytes.length + " bytes) to Nebulis project!");
            this.loadProcessingProject();

            (new MessageBox("File uploaded successfully to Nebulis project!", "Nebulis", StdIcon_Information, StdButton_Ok)).execute();
         } catch (err) {
            this.log("Upload failed: " + err.message);
            (new MessageBox("Upload failed: " + err.message, "Nebulis Error", StdIcon_Error, StdButton_Ok)).execute();
         }
      }
   };
}
}
: function NebulisDialogMock() {};

// ----------------------------------------------------------------------------
// Script Entry Point
// ----------------------------------------------------------------------------

/**
 * Initializes and executes the Nebulis Connector interactive dialog.
 */
function main() {
   console.show();
   console.writeln("<b>Nebulis Connector v" + NEBULIS_VERSION + " initialized.</b>");

   var client = new NebulisClient(nebulisConfig);
   var matcher = new CalibrationMatcher(nebulisConfig);
   var dialog = new NebulisDialog(client, matcher);

   // Auto-load library data on opening dialog
   dialog.loadLibraryData();

   dialog.execute();
}

// Check if running directly in PixInsight script engine
if (typeof PixInsight !== "undefined" || typeof Dialog !== "undefined") {
   main();
}

// Export for automated testing / headless environments
if (typeof module !== "undefined" && module.exports) {
   module.exports = {
      NebulisSettings: NebulisSettings,
      NebulisClient: NebulisClient,
      CalibrationMatcher: CalibrationMatcher,
      DSOThumbnailControl: DSOThumbnailControl,
      NebulisSettingsDialog: NebulisSettingsDialog,
      NebulisDialog: NebulisDialog
   };
}
