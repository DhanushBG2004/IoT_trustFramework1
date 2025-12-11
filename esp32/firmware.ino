#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>

// ====== WIFI (CHANGE THESE) ======
const char* ssid = "iPhone";          // ← replace with your hotspot name
const char* password = "harry123@"; // ← replace with your hotspot password

// Replace with your laptop's IP and port where gateway runs
String serverURL = "http://172.20.10.3:3000/data";

// Gateway API key (must match Gateway/.env GATEWAY_API_KEY)
const char* GATEWAY_API_KEY = "dhanushharini03080411"; // <-- set this to your gateway key

// --- Motor Pins ---
const int ENA = 25;   // PWM pin to L298N ENA
const int IN1 = 26;   // L298N IN1
const int IN2 = 27;   // L298N IN2

// --- Ultrasonic A ---
const int trigPinA = 5;
const int echoPinA = 17;

// --- Ultrasonic B ---
const int trigPinB = 14;
const int echoPinB = 16;

// --- RPM sensor (IR) ---
const int irSensorPin = 18;
volatile unsigned long pulseCount = 0;

// --- TrustScore ---
int trustA = 100, trustB = 100;
long lastDistA = -1, lastDistB = -1;

// Keep last computed rpm in a variable accessible to POST
unsigned long lastComputedRPM = 0;

// Posting / debounce settings
const unsigned long POST_INTERVAL_MS = 5000;   // heartbeat interval (5s)
const unsigned long DEBOUNCE_MS = 1500;        // min time between posts
const int TRUST_THRESHOLD = 60;
unsigned long lastPostTime = 0;

// --- PWM wrapper ---
// Use analogWrite ONLY (no ledcSetup/ledcAttachPin). On recent ESP32 Arduino cores,
// analogWrite is implemented and will work. If your core doesn't support analogWrite,
// see the alternate helper comment below.
void pwmWrite(int pin, int value) {
  if (value < 0) value = 0;
  if (value > 255) value = 255;
  // analogWrite on ESP32 Arduino core accepts 8-bit value (0-255) on many builds
  analogWrite(pin, value);
}

// --- ISR for IR sensor ---
void IRAM_ATTR countPulse() {
  pulseCount++;
}

// --- Read ultrasonic distance in cm ---
long readDistanceCM(int trigPin, int echoPin) {
  digitalWrite(trigPin, LOW);
  delayMicroseconds(2);
  digitalWrite(trigPin, HIGH);
  delayMicroseconds(10);
  digitalWrite(trigPin, LOW);

  long duration = pulseIn(echoPin, HIGH, 30000); // 30ms timeout
  if (duration == 0) return -1; // no echo
  return (long)(duration * 0.034 / 2.0);
}

unsigned long lastRPMTime = 0;

void computeAndResetRPM() {
  unsigned long now = millis();
  if (now - lastRPMTime >= 1000) {
    noInterrupts();
    unsigned long count = pulseCount;
    pulseCount = 0;
    interrupts();

    unsigned long rpm = count * 60UL; // if one pulse per revolution; adapt if different
    lastComputedRPM = rpm;
    lastRPMTime = now;
  }
}

void setup() {
  Serial.begin(115200);
  delay(50);

  // Motor setup
  pinMode(IN1, OUTPUT);
  pinMode(IN2, OUTPUT);
  pinMode(ENA, OUTPUT);
  digitalWrite(IN1, HIGH);
  digitalWrite(IN2, LOW);

  // IR sensor
  pinMode(irSensorPin, INPUT);
  attachInterrupt(digitalPinToInterrupt(irSensorPin), countPulse, RISING);

  // Ultrasonics
  pinMode(trigPinA, OUTPUT);
  pinMode(echoPinA, INPUT);
  pinMode(trigPinB, OUTPUT);
  pinMode(echoPinB, INPUT);

  Serial.println("Motor + Dual Ultrasonic + Dynamic TrustScore ready!");

  // ===== WIFI CONNECT =====
  WiFi.begin(ssid, password);
  Serial.print("Connecting to WiFi");
  unsigned long wifiStart = millis();
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
    if (millis() - wifiStart > 30000) {
      Serial.println("\nWiFi connection timeout. Restarting...");
      ESP.restart();
    }
  }
  Serial.println("\nConnected to WiFi!");
  Serial.print("ESP32 IP Address: ");
  Serial.println(WiFi.localIP());
  lastPostTime = 0;
  lastRPMTime = millis();
}

void doPostIfNeeded(long distA, long distB, int prevTrustA, int prevTrustB) {
  unsigned long now = millis();
  computeAndResetRPM();

  // Determine changes
  bool majorChange = (abs(trustA - prevTrustA) >= 3) || (abs(trustB - prevTrustB) >= 3);
  bool belowThreshold = (trustA < TRUST_THRESHOLD) || (trustB < TRUST_THRESHOLD);
  bool timeElapsed = (now - lastPostTime >= POST_INTERVAL_MS);

  if (!(majorChange || belowThreshold || timeElapsed)) return;
  if (now - lastPostTime < DEBOUNCE_MS) return; // debounce

  // Prepare JSON payload (timestamp in seconds)
  unsigned long tsSec = now / 1000UL;
  String eventId = String("evt-") + String(tsSec) + "-" + String(random(1000,9999));
  String deviceId = "esp32-01";
  String groupId = "group-1";
  String reason = belowThreshold ? "LOW_TRUST" : (majorChange ? "TRUST_CHANGE" : "PERIODIC");

  String jsonData = "{";
  jsonData += "\"eventId\":\"" + eventId + "\",";
  jsonData += "\"deviceId\":\"" + deviceId + "\",";
  jsonData += "\"groupId\":\"" + groupId + "\",";
  jsonData += "\"oldTS\":" + String(prevTrustA) + ",";
  jsonData += "\"newTS\":" + String(trustA) + ",";
  jsonData += "\"trustA\":" + String(trustA) + ",";
  jsonData += "\"trustB\":" + String(trustB) + ",";
  jsonData += "\"distA\":" + String(distA) + ",";
  jsonData += "\"distB\":" + String(distB) + ",";
  jsonData += "\"speed\":" + String(lastComputedRPM) + ",";
  jsonData += "\"reason\":\"" + reason + "\",";
  jsonData += "\"ts\":" + String(tsSec);
  jsonData += "}";

  Serial.println("Posting to gateway: ");
  Serial.println(jsonData);

  HTTPClient http;
  http.setConnectTimeout(5000);
  http.begin(serverURL.c_str()); // serverURL is a String - use c_str()
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-api-key", GATEWAY_API_KEY);

  int httpResponseCode = http.POST(jsonData);

  Serial.print("POST -> ");
  Serial.println(httpResponseCode);

  if (httpResponseCode > 0) {
    String response = http.getString();
    Serial.print("Server says: ");
    Serial.println(response);
  } else {
    Serial.print("Error sending: ");
    Serial.println(http.errorToString(httpResponseCode));
    // retry once after short delay
    delay(1500);
    Serial.println("Retrying once...");
    int try2 = http.POST(jsonData);
    Serial.print("Retry -> ");
    Serial.println(try2);
    if (try2 > 0) {
      String response2 = http.getString();
      Serial.print("Server says: ");
      Serial.println(response2);
    } else {
      Serial.print("Retry failed: ");
      Serial.println(http.errorToString(try2));
    }
  }

  http.end();
  lastPostTime = now;
}

void loop() {
  // --- Read distances ---
  long distA = readDistanceCM(trigPinA, echoPinA);
  long distB = readDistanceCM(trigPinB, echoPinB);

  // --- Update TrustScores dynamically ---
  int prevTrustA = trustA;
  int prevTrustB = trustB;

  if (distA > 0 && lastDistA > 0) {
    int deltaA = abs(distA - lastDistA);
    if (deltaA > 0) trustA = max(0, trustA - 1);   // any change decreases trust slightly
    else trustA = min(100, trustA + 1);            // stable → increase trust
  }

  if (distB > 0 && lastDistB > 0) {
    int deltaB = abs(distB - lastDistB);
    if (deltaB > 0) trustB = max(0, trustB - 1);
    else trustB = min(100, trustB + 1);
  }

  // Clamp trust scores strictly between 0–100
  trustA = constrain(trustA, 0, 100);
  trustB = constrain(trustB, 0, 100);

  lastDistA = (distA > 0) ? distA : lastDistA;
  lastDistB = (distB > 0) ? distB : lastDistB;

  // --- Decide trusted sensor ---
  long chosenDist;
  String controller;
  if (trustA >= trustB) {
    chosenDist = distA;
    controller = "A";
  } else {
    chosenDist = distB;
    controller = "B";
  }

  // --- Map chosen distance to motor speed ---
  int motorSpeed = 0;
  if (chosenDist > 5) {
    if (chosenDist >= 50) motorSpeed = 255;
    else motorSpeed = map(chosenDist, 5, 50, 0, 255);
  }

  // --- Apply motor speed ---
  if (motorSpeed == 0) {
    digitalWrite(IN1, LOW);
    digitalWrite(IN2, LOW);
    pwmWrite(ENA, 0);
  } else {
    digitalWrite(IN1, HIGH);
    digitalWrite(IN2, LOW);
    pwmWrite(ENA, motorSpeed);
  }

  // --- Compute RPM every 1s (updates lastComputedRPM) ---
  computeAndResetRPM();

  // --- Possibly post event to Gateway ---
  if (WiFi.status() == WL_CONNECTED) {
    doPostIfNeeded(distA, distB, prevTrustA, prevTrustB);
  } else {
    Serial.println("WiFi not connected, skipping POST");
  }

  delay(250);
}
