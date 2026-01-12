"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TopicId = exports.OccupationCategory = exports.AgeBand = exports.UserState = void 0;
var UserState;
(function (UserState) {
    UserState["CREATED"] = "CREATED";
    UserState["ONBOARDING"] = "ONBOARDING";
    UserState["ACTIVE"] = "ACTIVE";
})(UserState || (exports.UserState = UserState = {}));
var AgeBand;
(function (AgeBand) {
    AgeBand["AGE_13_17"] = "13-17";
    AgeBand["AGE_18_24"] = "18-24";
    AgeBand["AGE_25_34"] = "25-34";
    AgeBand["AGE_35_44"] = "35-44";
    AgeBand["AGE_45_PLUS"] = "45+";
})(AgeBand || (exports.AgeBand = AgeBand = {}));
var OccupationCategory;
(function (OccupationCategory) {
    OccupationCategory["STUDENT"] = "student";
    OccupationCategory["WORKING"] = "working";
    OccupationCategory["BETWEEN_JOBS"] = "between_jobs";
    OccupationCategory["OTHER"] = "other";
})(OccupationCategory || (exports.OccupationCategory = OccupationCategory = {}));
var TopicId;
(function (TopicId) {
    TopicId["POLITICS"] = "POLITICS";
    TopicId["RELIGION"] = "RELIGION";
    TopicId["SEXUAL_CONTENT"] = "SEXUAL_CONTENT";
    TopicId["SEXUAL_JOKES"] = "SEXUAL_JOKES";
    TopicId["MENTAL_HEALTH"] = "MENTAL_HEALTH";
    TopicId["SELF_HARM"] = "SELF_HARM";
    TopicId["SUBSTANCES"] = "SUBSTANCES";
    TopicId["GAMBLING"] = "GAMBLING";
    TopicId["VIOLENCE"] = "VIOLENCE";
    TopicId["ILLEGAL_ACTIVITY"] = "ILLEGAL_ACTIVITY";
    TopicId["HATE_HARASSMENT"] = "HATE_HARASSMENT";
    TopicId["MEDICAL_HEALTH"] = "MEDICAL_HEALTH";
    TopicId["PERSONAL_FINANCE"] = "PERSONAL_FINANCE";
    TopicId["RELATIONSHIPS"] = "RELATIONSHIPS";
    TopicId["FAMILY"] = "FAMILY";
    TopicId["WORK_SCHOOL"] = "WORK_SCHOOL";
    TopicId["TRAVEL"] = "TRAVEL";
    TopicId["ENTERTAINMENT"] = "ENTERTAINMENT";
    TopicId["TECH_GAMING"] = "TECH_GAMING";
})(TopicId || (exports.TopicId = TopicId = {}));
//# sourceMappingURL=enums.js.map